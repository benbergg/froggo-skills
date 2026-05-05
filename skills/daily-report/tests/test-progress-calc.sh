#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/progress.sh"

test_start "test-progress-calc"

# 1. P1 hours hit: consumed=8, left=4 => 8/(8+4) = 67%
tasks=$(cat "$DIR/fixtures/progress-hours.json")
out=$(calc_progress 1234 "$tasks" testing)
assert_eq "$(echo "$out" | jq -r '.value')" "67" "P1 hours value"
assert_eq "$(echo "$out" | jq -r '.source')" "hours" "P1 source"

# 2. P2 count fallback: all hours zero, 1 done out of 2 tasks => 50%
tasks=$(cat "$DIR/fixtures/progress-count.json")
out=$(calc_progress 1230 "$tasks" developing)
assert_eq "$(echo "$out" | jq -r '.value')" "50" "P2 count value"
assert_eq "$(echo "$out" | jq -r '.source')" "count" "P2 source"

# 3. P3 stage fallback: no tasks => stage map
tasks=$(cat "$DIR/fixtures/progress-stage.json")
for stage_pct in "wait:0" "planned:10" "developing:40" "testing:75" "closed:100"; do
  stage="${stage_pct%:*}"; expected="${stage_pct#*:}"
  out=$(calc_progress 9999 "$tasks" "$stage")
  assert_eq "$(echo "$out" | jq -r '.value')" "$expected" "P3 stage=$stage"
  assert_eq "$(echo "$out" | jq -r '.source')" "stage" "P3 source for $stage"
done

# 4. Progress bar render
assert_eq "$(render_bar 0)"   "[░░░░░░░░░░]" "bar 0"
assert_eq "$(render_bar 50)"  "[█████░░░░░]" "bar 50"
assert_eq "$(render_bar 80)"  "[████████░░]" "bar 80"
assert_eq "$(render_bar 100)" "[██████████]" "bar 100"

test_end
