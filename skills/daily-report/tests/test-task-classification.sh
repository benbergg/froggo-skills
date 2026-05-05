#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/collect-tasks.sh"

test_start "test-task-classification"

# type emoji mapping
assert_eq "$(task_type_label design)"  "📐 设计"  "design label"
assert_eq "$(task_type_label devel)"   "💻 开发"  "devel label"
assert_eq "$(task_type_label test)"    "🧪 测试"  "test label"
assert_eq "$(task_type_label study)"   "🔍 研究"  "study label"
assert_eq "$(task_type_label discuss)" "💬 讨论"  "discuss label"
assert_eq "$(task_type_label ui)"      "🎨 UI"    "ui label"
assert_eq "$(task_type_label talk)"    "📞 沟通"  "talk label"
assert_eq "$(task_type_label request)" "📌 需求"  "request label"
assert_eq "$(task_type_label affair)"  "📝 事务"  "affair label"
assert_eq "$(task_type_label others)"  "🔧 其他"  "others label"
# Unknown type falls back to emoji + raw type name
assert_eq "$(task_type_label weird)"   "❓ weird" "unknown type fallback"

# Range filter: 8 tasks have story in [1234, 1230, 1235, 1200]; id=9999 has story=0 and is excluded
tasks=$(cat "$DIR/fixtures/tasks-300.json")
range_ids='[1234, 1230, 1235, 1200]'
filtered=$(filter_tasks_by_stories "$tasks" "$range_ids")
assert_eq "$(echo "$filtered" | jq 'length')" "8" "8 tasks in range (excludes 9999 with story=0)"

test_end
