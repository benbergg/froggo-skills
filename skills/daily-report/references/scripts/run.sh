#!/usr/bin/env bash
# Main entrypoint: Step 0 -> Step 7 (see design doc §8)

set -euo pipefail

DAILY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPTS="$DAILY_DIR/scripts"
ZT_FUNCTIONS="$DAILY_DIR/../../zentao-api/scripts/zt-functions.sh"

# Step 0: Source zentao-api toolkit (provides zt_init/zt_get/zt_paginate/etc.)
if [ -f "$ZT_FUNCTIONS" ]; then
  source "$ZT_FUNCTIONS"
else
  echo "FATAL: cannot find zt-functions.sh at $ZT_FUNCTIONS" >&2
  exit 1
fi

# Step 0: Source all helper scripts
source "$SCRIPTS/retry.sh"
source "$SCRIPTS/role-map-loader.sh"
source "$SCRIPTS/progress.sh"
source "$SCRIPTS/collect-stories.sh"
source "$SCRIPTS/collect-bugs.sh"
source "$SCRIPTS/collect-tasks.sh"
source "$SCRIPTS/aggregate.sh"
source "$SCRIPTS/render.sh"
source "$SCRIPTS/check.sh"
source "$SCRIPTS/feishu-push.sh"

MODE=${1:-manual}   # manual | cron

# Step 0: Setup — date vars and API budget
TODAY=$(date "+%Y-%m-%d")
TODAY_START=$(date "+%Y-%m-%dT00:00:00Z")
NOW=$(date -u "+%Y-%m-%dT%H:%M:%SZ")
export TODAY TODAY_START NOW
export API_CALL_COUNT=0
export DAILY_API_BUDGET="${DAILY_API_BUDGET:-600}"
export DAILY_TASK_LIMIT="${DAILY_TASK_LIMIT:-500}"

# zentao-api 6 snippet assumed already loaded in caller's shell
zt_init && zt_acquire_token >/dev/null

# Resolve product list
if [ "${ZENTAO_PRODUCTS:-95}" = "all" ]; then
  PRODUCTS=$(zt_get /user | jq -r '.profile.view.products[]' | tr '\n' ',' | sed 's/,$//')
else
  PRODUCTS="${ZENTAO_PRODUCTS:-95}"
fi
echo "covering products: $PRODUCTS"

# Load role mapping
ROLE_JSON=$(load_role_map "${ZENTAO_ROLE_MAP:-$HOME/.zentao-roles.yaml}")

# Step 1: Prepare output file path.
# Auto-detect knowledge library: env override > ~/workspace/Knowledge-Library > ~/Knowledge-Library.
# Avoid hardcoding so the skill is portable across machines.
if [ -n "${KNOWLEDGE_LIB:-}" ]; then
  : # explicit override
elif [ -d "$HOME/workspace/Knowledge-Library" ]; then
  KNOWLEDGE_LIB="$HOME/workspace/Knowledge-Library"
elif [ -d "$HOME/Knowledge-Library" ]; then
  KNOWLEDGE_LIB="$HOME/Knowledge-Library"
else
  echo "FATAL: KNOWLEDGE_LIB not found. Set env or create one of: ~/workspace/Knowledge-Library, ~/Knowledge-Library" >&2
  exit 1
fi
echo "knowledge library: $KNOWLEDGE_LIB"
OUTPUT_FILE="${KNOWLEDGE_LIB}/05-Reports/daily/${TODAY}.md"
if [ -f "$OUTPUT_FILE" ]; then
  if [ "$MODE" = "cron" ]; then
    echo "already exists, skip cron"; exit 0
  else
    OUTPUT_FILE="/tmp/daily-${TODAY}.md"
    echo "manual override: writing to $OUTPUT_FILE"
  fi
fi

# Step 2: Collect per product + Step 3: Compute progress
PRODUCT_FILES=()
IFS=',' read -ra PIDS <<< "$PRODUCTS"
for pid in "${PIDS[@]}"; do
  echo "-> collecting product $pid"

  # Fetch real product name (fallback to Product-{pid} on failure)
  PRODUCT_NAME=$(retry_with_backoff zt_get "/products/$pid" 2>/dev/null | jq -r '.name // empty')
  [ -z "$PRODUCT_NAME" ] && PRODUCT_NAME="Product-${pid}"

  STORIES=$(collect_stories_for_product "$pid" "$TODAY_START")
  BUGS_RAW=$(collect_bugs_for_product "$pid")
  # Filter to in-scope bugs: all non-closed + today-closed only.
  # Historical closed bugs are dropped to keep the report focused on current/today work.
  BUGS_RAW=$(filter_in_scope_bugs "$BUGS_RAW" "$TODAY_START")
  BUGS_SNAPSHOT=$(classify_bugs "$BUGS_RAW")
  BUGS_TODAY=$(today_bugs "$BUGS_RAW" "$TODAY_START")

  RANGE_IDS=$(echo "$STORIES" | jq '[.in_progress[].id, .today_done[].id]')

  TASKS=$(collect_tasks_for_product "$pid")
  RANGE_TASKS=$(filter_tasks_by_stories "$TASKS" "$RANGE_IDS")
  DEGRADE=$(should_degrade_tasks "$RANGE_TASKS")
  RANGE_TASK_COUNT=$(echo "$RANGE_TASKS" | jq 'length')

  # Attach per-story task lists (placeholder progress; bash loop fills real value below).
  # Use slurpfile for tasks to avoid ARG_MAX limit with hundreds of tasks.
  TASKS_F="/tmp/daily-${TODAY}-${pid}-tasks.tmp.json"
  echo "$RANGE_TASKS" > "$TASKS_F"
  STORIES_WITH_PROGRESS=$(echo "$STORIES" | jq \
    --slurpfile tasks_arr "$TASKS_F" \
    --arg degrade "$DEGRADE" '
    ($tasks_arr[0]) as $tasks
    | .in_progress |= map(
      . as $story
      | . + {
        progress: { value: 0, source: "stage" },
        tasks: (if $degrade == "true" then [] else [$tasks[] | select(.story == $story.id)] end)
      }
    )
  ')

  # Step 3: Fill real progress for in_progress stories
  N=$(echo "$STORIES_WITH_PROGRESS" | jq '.in_progress | length')
  for ((i=0; i<N; i++)); do
    sid=$(echo "$STORIES_WITH_PROGRESS" | jq -r ".in_progress[$i].id")
    stg=$(echo "$STORIES_WITH_PROGRESS" | jq -r ".in_progress[$i].stage")
    p=$(calc_progress "$sid" "$RANGE_TASKS" "$stg")
    STORIES_WITH_PROGRESS=$(echo "$STORIES_WITH_PROGRESS" | \
      jq --argjson p "$p" --argjson i "$i" '.in_progress[$i].progress = $p')
  done

  # Fill progress for today_done / unassigned / idle buckets (stage-based)
  for bucket in today_done unassigned idle; do
    M=$(echo "$STORIES_WITH_PROGRESS" | jq ".${bucket} | length")
    for ((j=0; j<M; j++)); do
      sid=$(echo "$STORIES_WITH_PROGRESS" | jq -r ".${bucket}[$j].id")
      stg=$(echo "$STORIES_WITH_PROGRESS" | jq -r ".${bucket}[$j].stage")
      p=$(calc_progress "$sid" "$RANGE_TASKS" "$stg")
      STORIES_WITH_PROGRESS=$(echo "$STORIES_WITH_PROGRESS" | \
        jq --argjson p "$p" --argjson j "$j" ".${bucket}[\$j].progress = \$p")
    done
  done

  # Annotate bugs.all with today_event for renderer
  BUGS_ALL=$(echo "$BUGS_RAW" | jq --arg t "$TODAY_START" '
    map(. + {
      today_event: (
        if (.openedDate != null and .openedDate >= $t) then "today_opened"
        elif (.resolvedDate != null and .resolvedDate >= $t) then "today_resolved"
        elif (.closedDate != null and .closedDate >= $t) then "today_closed"
        else "" end
      )
    })
  ')

  # Write per-product JSON.
  # Use slurpfile for the four large JSON values to avoid OS ARG_MAX limit
  # ('jq: Argument list too long' for products with many stories/tasks/bugs).
  PFILE="/tmp/daily-${TODAY}-${pid}.json"
  STORIES_F="/tmp/daily-${TODAY}-${pid}-stories.tmp.json"
  SNAP_F="/tmp/daily-${TODAY}-${pid}-snap.tmp.json"
  TODAY_F="/tmp/daily-${TODAY}-${pid}-today.tmp.json"
  ALL_F="/tmp/daily-${TODAY}-${pid}-all.tmp.json"
  echo "$STORIES_WITH_PROGRESS" > "$STORIES_F"
  echo "$BUGS_SNAPSHOT" > "$SNAP_F"
  echo "$BUGS_TODAY" > "$TODAY_F"
  echo "$BUGS_ALL" > "$ALL_F"
  jq -n \
    --slurpfile stories "$STORIES_F" \
    --slurpfile snap "$SNAP_F" \
    --slurpfile today "$TODAY_F" \
    --slurpfile all_arr "$ALL_F" \
    --arg date_str "$TODAY" \
    --argjson pid "$pid" \
    --arg pname "$PRODUCT_NAME" \
    --argjson degrade "$([ "$DEGRADE" = "true" ] && echo true || echo false)" \
    --argjson rcount "$RANGE_TASK_COUNT" '
    {
      date: $date_str,
      product: { id: $pid, name: $pname, task_limit_exceeded: $degrade, range_task_count: $rcount },
      stories: $stories[0],
      bugs: { snapshot: $snap[0], today: $today[0], all: $all_arr[0] },
      person_workload: {}
    }
  ' > "$PFILE"
  rm -f "$STORIES_F" "$SNAP_F" "$TODAY_F" "$ALL_F"
  PRODUCT_FILES+=("$PFILE")
done

# Step 4: Aggregate + render
AGG_FILE="/tmp/daily-${TODAY}.aggregated.json"
aggregate "${PRODUCT_FILES[@]}" "$ROLE_JSON" > "$AGG_FILE"

DRAFT_MD="/tmp/daily-${TODAY}.md"
render_markdown "$AGG_FILE" > "$DRAFT_MD"

SUMMARY_FILE="/tmp/daily-${TODAY}.summary.txt"
build_summary "$AGG_FILE" > "$SUMMARY_FILE"

# Step 5: Evaluate — abort if score < 70
SCORE=$(score_total "$DRAFT_MD" "$AGG_FILE" "$SUMMARY_FILE")
echo "evaluation score: $SCORE"
if [ "$SCORE" -lt 70 ]; then
  cp "$DRAFT_MD" "/tmp/daily-${TODAY}.draft.md"
  echo "score < 70, draft saved to /tmp/daily-${TODAY}.draft.md"
  if [ "$MODE" = "cron" ]; then
    push_to_feishu "${FEISHU_ALERT_WEBHOOK:-${FEISHU_DAILY_WEBHOOK:-}}" \
      "daily-report evaluation failed (score=$SCORE), draft saved" || true
  fi
  exit 1
fi

# Step 6: Save to output file + git push
mkdir -p "$(dirname "$OUTPUT_FILE")"
cp "$DRAFT_MD" "$OUTPUT_FILE"
echo "written: $OUTPUT_FILE"

if [ "$MODE" = "cron" ] || [ -d "$KNOWLEDGE_LIB/.git" ]; then
  cd "$KNOWLEDGE_LIB"
  if [[ "$OUTPUT_FILE" == "$KNOWLEDGE_LIB"/* ]]; then
    git_relative_path="${OUTPUT_FILE#$KNOWLEDGE_LIB/}"
    git add "$git_relative_path"
  fi
  git commit -m "docs(daily): ${TODAY}" || echo "nothing to commit"
  if ! git push 2>&1 | tee /tmp/daily-push.log; then
    git pull --rebase && git push || {
      echo "git push failed twice"
      if [ "$MODE" = "cron" ]; then
        push_to_feishu \
          "${FEISHU_ALERT_WEBHOOK:-${FEISHU_DAILY_WEBHOOK:-}}" \
          "daily-report git push failed: $(cat /tmp/daily-push.log)" || true
      fi
      exit 1
    }
  fi
fi

# Step 7: Push Feishu summary
push_summary "$AGG_FILE" "$MODE" || \
  echo "feishu skipped/failed (non-fatal in $MODE mode)"

echo "daily-report done"
