#!/usr/bin/env bash
# P4 mixed progress algorithm + 10-cell bar renderer.

calc_progress() {
  local story_id=$1
  local tasks_json=$2
  local stage=$3

  # P1: hours-based — use if sum of (consumed + left) > 0
  local p1
  p1=$(echo "$tasks_json" | jq --argjson sid "$story_id" '
    [.[] | select(.story == $sid)]
    | (map(.consumed // 0 | tonumber) | add // 0) as $c
    | (map(.left // 0 | tonumber) | add // 0) as $l
    | if ($c + $l) > 0 then
        { value: (($c / ($c + $l)) * 100 | round), source: "hours" }
      else null end
  ')
  if [ "$p1" != "null" ]; then echo "$p1"; return; fi

  # P2: count-based — use if any tasks exist for this story
  local p2
  p2=$(echo "$tasks_json" | jq --argjson sid "$story_id" '
    [.[] | select(.story == $sid)] as $tasks
    | ($tasks | length) as $total
    | ($tasks | map(select(.status == "done" or .status == "closed")) | length) as $done
    | if $total > 0 then
        { value: (($done / $total) * 100 | round), source: "count" }
      else null end
  ')
  if [ "$p2" != "null" ]; then echo "$p2"; return; fi

  # P3: stage-based fallback map
  case "$stage" in
    wait)              echo '{"value":0,"source":"stage"}' ;;
    planned)           echo '{"value":10,"source":"stage"}' ;;
    projected)         echo '{"value":20,"source":"stage"}' ;;
    developing)        echo '{"value":40,"source":"stage"}' ;;
    developed)         echo '{"value":60,"source":"stage"}' ;;
    testing)           echo '{"value":75,"source":"stage"}' ;;
    tested)            echo '{"value":90,"source":"stage"}' ;;
    closed|released)   echo '{"value":100,"source":"stage"}' ;;
    *)                 echo '{"value":0,"source":"stage"}' ;;
  esac
}

render_bar() {
  local pct=$1
  local filled=$((pct / 10))
  [ $filled -gt 10 ] && filled=10
  [ $filled -lt 0 ]  && filled=0
  local empty=$((10 - filled))
  local f=""
  local e=""
  for ((i=0; i<filled; i++)); do f="${f}█"; done
  for ((i=0; i<empty;  i++)); do e="${e}░"; done
  printf "[%s%s]" "$f" "$e"
}

export -f calc_progress render_bar
