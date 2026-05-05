#!/usr/bin/env bash
# Main entrypoint: Step 0 -> Step 7 (see design doc §8)

set -euo pipefail

DAILY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRIPTS="$DAILY_DIR/scripts"

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

# Step 1: Prepare output file path
KNOWLEDGE_LIB="${KNOWLEDGE_LIB:-$HOME/Knowledge-Library}"
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

  STORIES=$(collect_stories_for_product "$pid" "$TODAY_START")
  BUGS_RAW=$(collect_bugs_for_product "$pid")
  BUGS_SNAPSHOT=$(classify_bugs "$BUGS_RAW")
  BUGS_TODAY=$(today_bugs "$BUGS_RAW" "$TODAY_START")

  RANGE_IDS=$(echo "$STORIES" | jq '[.in_progress[].id, .today_done[].id]')

  TASKS=$(collect_tasks_for_product "$pid")
  RANGE_TASKS=$(filter_tasks_by_stories "$TASKS" "$RANGE_IDS")
  DEGRADE=$(should_degrade_tasks "$RANGE_TASKS")
  RANGE_TASK_COUNT=$(echo "$RANGE_TASKS" | jq 'length')

  # Attach per-story task lists (placeholder progress; bash loop fills real value below)
  STORIES_WITH_PROGRESS=$(echo "$STORIES" | jq \
    --argjson tasks "$RANGE_TASKS" \
    --arg degrade "$DEGRADE" '
    .in_progress |= map(
      . + {
        progress: { value: 0, source: "stage" },
        tasks: (if $degrade == "true" then [] else [$tasks[] | select(.story == .id)] end)
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

  # Write per-product JSON
  PFILE="/tmp/daily-${TODAY}-${pid}.json"
  jq -n \
    --argjson stories "$STORIES_WITH_PROGRESS" \
    --argjson snap "$BUGS_SNAPSHOT" \
    --argjson today "$BUGS_TODAY" \
    --argjson all  "$BUGS_ALL" \
    --arg date_str "$TODAY" \
    --argjson pid "$pid" \
    --arg pname "Product-${pid}" \
    --argjson degrade "$([ "$DEGRADE" = "true" ] && echo true || echo false)" \
    --argjson rcount "$RANGE_TASK_COUNT" '
    {
      date: $date_str,
      product: { id: $pid, name: $pname, task_limit_exceeded: $degrade, range_task_count: $rcount },
      stories: $stories,
      bugs: { snapshot: $snap, today: $today, all: $all },
      person_workload: {}
    }
  ' > "$PFILE"
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
  git add "$(realpath --relative-to="$KNOWLEDGE_LIB" "$OUTPUT_FILE")"
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
