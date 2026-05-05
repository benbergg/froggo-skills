#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/collect-stories.sh"

test_start "test-today-filter"

stories=$(jq '.stories' "$DIR/fixtures/stories-200.json")

# closedDate=2026-05-05 + TODAY_START=2026-05-05 → today_done
classified=$(classify_stories "$stories" "2026-05-05T00:00:00Z")
assert_eq "$(echo "$classified" | jq '.today_done | length')" "1" "today_done with 05-05"

# closedDate=2026-05-05 + TODAY_START=2026-05-06 → not today_done (excluded as early_done)
classified=$(classify_stories "$stories" "2026-05-06T00:00:00Z")
assert_eq "$(echo "$classified" | jq '.today_done | length')" "0" "0 today_done with 05-06"

test_end
