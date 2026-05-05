#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/retry.sh"

test_start "test-retry"

# 1. Successful call: passes through output and increments API_CALL_COUNT
export API_CALL_COUNT=0
export DAILY_API_BUDGET=5
output=$(retry_with_backoff echo "ok")
assert_eq "$output" "ok" "echo passes through"
assert_eq "$API_CALL_COUNT" "1" "count incremented"

# 2. Rate-limit simulation: command outputs "rate limit", retries 4 times then fails
fail_with_429() { echo "rate limit hit"; return 1; }
export -f fail_with_429
export API_CALL_COUNT=0
DAILY_BACKOFF_OVERRIDE="0 0 0 0" output=$(retry_with_backoff fail_with_429 2>&1) || rc=$?
assert_eq "${rc:-0}" "1" "exhaust retries returns 1"
assert_eq "$API_CALL_COUNT" "4" "4 attempts counted"

# 3. Non-rate-limit error returns immediately without retrying
fail_unrelated() { echo "other error"; return 1; }
export -f fail_unrelated
export API_CALL_COUNT=0
output=$(retry_with_backoff fail_unrelated 2>&1) || rc=$?
assert_eq "${rc:-0}" "1" "non-rate-limit error returns 1"
assert_eq "$API_CALL_COUNT" "1" "no retry on non-rate-limit"

# 4. Budget exceeded: exits with code 2 and prints BUDGET_EXCEEDED
export API_CALL_COUNT=5
export DAILY_API_BUDGET=5
output=$(retry_with_backoff echo "ok" 2>&1) || rc=$?
assert_eq "${rc:-0}" "2" "budget exceeded exit code 2"
assert_contains "$output" "BUDGET_EXCEEDED" "budget message"

test_end
