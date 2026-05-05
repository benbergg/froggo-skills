#!/usr/bin/env bash
# Evaluation gate: 8 dimensions + source-weighted progress (see design doc §7.1/§7.2)

# score_frontmatter <md_text>
# Checks 5 required frontmatter fields (created/updated/type/date/products) × 2 pts each = 10 max.
# tags is a bonus field but carries no points in current scoring.
score_frontmatter() {
  local md=$1
  local fm
  fm=$(echo "$md" | awk '/^---$/{c++; next} c==1{print}')
  local got=0
  for k in created updated type date products; do
    echo "$fm" | grep -qE "^${k}:" && got=$((got + 2))
  done
  # tags: bonus field, no points currently
  if echo "$fm" | grep -qE "^tags:"; then got=$((got + 0)); fi
  # 5 fields × 2 = 10
  echo "$got"
}

# score_wikilinks <md_text>
# All S/B/T-prefixed ID tokens must appear in [[...]] form.
# Returns 10 if all are bracketed, 0 if none are tokens, ratio otherwise.
score_wikilinks() {
  local md=$1
  local total
  total=$(echo "$md" | grep -oE '\b[SBT][0-9]+\b' | wc -l | tr -d ' ')
  local linked
  linked=$(echo "$md" | grep -oE '\[\[[SBT][0-9]+\]\]' | wc -l | tr -d ' ')
  if [ "$total" -eq 0 ]; then echo "10"; return; fi
  if [ "$linked" -eq "$total" ]; then echo "10"; return; fi
  # Ratio scoring for partial compliance
  echo $(( (linked * 10) / total ))
}

# score_summary_length <summary_text>
# Character count (Chinese counts as 1 via wc -m). Returns 10 if ≤ 200, else 0.
score_summary_length() {
  local summary=$1
  local len
  len=$(echo -n "$summary" | wc -m | tr -d ' ')
  if [ "$len" -le 200 ]; then echo "10"; else echo "0"; fi
}

# score_progress <agg_json>
# Source-weighted progress sanity check. Base score 15; each violation deducts 5 (floor 0).
# stage (strict): wait=0, closed/released=100, testing=75
# count (medium): closed/released must be 100
# hours (lenient): closed/released must be 100; wait must be < 30
score_progress() {
  local agg=$1
  local items
  items=$(echo "$agg" | jq -c '
    [.products[].stories
     | (.in_progress + .today_done + .unassigned + .idle)[]
     | {value: .progress.value, source: .progress.source, stage: .stage}]
  ')

  local total
  total=$(echo "$items" | jq 'length')
  if [ "$total" -eq 0 ]; then echo "15"; return; fi

  local deductions=0
  while read -r item; do
    [ -z "$item" ] && continue
    local v s stg
    v=$(echo "$item" | jq -r '.value')
    s=$(echo "$item" | jq -r '.source')
    stg=$(echo "$item" | jq -r '.stage')

    case "$s" in
      stage)
        # Strict: value must match the stage mapping exactly; violation deducts 10
        local violated=0
        case "$stg" in
          wait)            [ "$v" = "0" ]   || violated=1 ;;
          closed|released) [ "$v" = "100" ] || violated=1 ;;
          testing)         [ "$v" = "75" ]  || violated=1 ;;
          # Other stages not validated in current scope
        esac
        [ "$violated" -eq 1 ] && deductions=$((deductions + 10))
        ;;
      count)
        # Medium: only closed/released must be 100; violation deducts 5
        if [ "$stg" = "closed" ] || [ "$stg" = "released" ]; then
          [ "$v" = "100" ] || deductions=$((deductions + 5))
        fi
        ;;
      hours)
        # Lenient: only enforce closed=100 and wait<30; violation deducts 5
        if [ "$stg" = "closed" ] || [ "$stg" = "released" ]; then
          [ "$v" = "100" ] || deductions=$((deductions + 5))
        elif [ "$stg" = "wait" ]; then
          [ "$v" -lt 30 ] || deductions=$((deductions + 5))
        fi
        ;;
    esac
  done < <(echo "$items" | jq -c '.[]')

  # 15 pts base; stage violations deduct 10, count/hours deduct 5; floor at 0
  local score=$((15 - deductions))
  [ "$score" -lt 0 ] && score=0
  echo "$score"
}

# score_total <md_file> <agg_file> <summary_file>
# Composes all dimension scores into a total out of 100.
# Unimplemented dimensions (data 25, time 15, range 10, task 5) default to full score in V1.
score_total() {
  local md_file=$1
  local agg_file=$2
  local summary_file=$3

  local md
  md=$(cat "$md_file")
  local agg
  agg=$(cat "$agg_file")
  local summary
  summary=$(cat "$summary_file")

  local s_fm s_wl s_sm s_pr
  s_fm=$(score_frontmatter "$md")
  s_wl=$(score_wikilinks "$md")
  s_sm=$(score_summary_length "$summary")
  s_pr=$(score_progress "$agg")

  # V1 placeholders: data completeness 25 / time accuracy 15 / range/category 10 / task render 5
  # These will be replaced with strict checks in future iterations.
  local s_data=25 s_time=15 s_range=10 s_task=5

  local total=$((s_fm + s_wl + s_sm + s_pr + s_data + s_time + s_range + s_task))
  echo "$total"
}

export -f score_frontmatter score_wikilinks score_summary_length score_progress score_total
