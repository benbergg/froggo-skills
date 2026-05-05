#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/collect-bugs.sh"

test_start "test-bug-classification"

bugs=$(jq '.bugs' "$DIR/fixtures/bugs-100.json")
TODAY_START="2026-05-05T00:00:00Z"

snapshot=$(classify_bugs "$bugs")

# Status buckets
assert_eq "$(echo "$snapshot" | jq '."新增/未处理" | length')" "1" "新增/未处理 (5691)"
assert_eq "$(echo "$snapshot" | jq '."处理中" | length')"     "1" "处理中 (5685)"
assert_eq "$(echo "$snapshot" | jq '."已解决待验" | length')" "1" "已解决待验 (5678)"
assert_eq "$(echo "$snapshot" | jq '."已关闭" | length')"     "2" "已关闭 (5670, 5500)"

# Today changes
today=$(today_bugs "$bugs" "$TODAY_START")
assert_eq "$(echo "$today" | jq '."新建" | length')"  "2" "今日新建 (5685, 5691)"
assert_eq "$(echo "$today" | jq '."解决" | length')"  "1" "今日解决 (5678)"
assert_eq "$(echo "$today" | jq '."关闭" | length')"  "1" "今日关闭 (5670)"

test_end
