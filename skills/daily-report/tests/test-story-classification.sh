#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/collect-stories.sh"

test_start "test-story-classification"

stories=$(jq '.stories' "$DIR/fixtures/stories-200.json")
TODAY_START="2026-05-05T00:00:00Z"

classified=$(classify_stories "$stories" "$TODAY_START")

# Four-bucket counts
in_prog=$(echo "$classified" | jq '.in_progress | length')
today_done=$(echo "$classified" | jq '.today_done | length')
unassigned=$(echo "$classified" | jq '.unassigned | length')
idle=$(echo "$classified" | jq '.idle | length')
assert_eq "$in_prog" "3"     "in_progress count (1234, 1230, 1235)"
assert_eq "$today_done" "1"  "today_done count (1200)"
assert_eq "$unassigned" "1"  "unassigned count (1240)"
assert_eq "$idle" "1"        "idle count (1245)"

# Exclusion: early_done not in any bucket
all_ids=$(echo "$classified" | jq '[.in_progress[].id, .today_done[].id, .unassigned[].id, .idle[].id]')
assert_not_contains "$all_ids" "1100" "early_done 1100 excluded"
assert_not_contains "$all_ids" "1101" "early_done 1101 excluded"

# unassigned: stage=wait + assignedTo empty
unassigned_id=$(echo "$classified" | jq -r '.unassigned[0].id')
assert_eq "$unassigned_id" "1240" "unassigned is 1240"

# idle: stage=wait + assignedTo non-empty
idle_id=$(echo "$classified" | jq -r '.idle[0].id')
assert_eq "$idle_id" "1245" "idle is 1245"

test_end
