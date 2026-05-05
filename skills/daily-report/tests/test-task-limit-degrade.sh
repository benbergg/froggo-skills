#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/collect-tasks.sh"

test_start "test-task-limit-degrade"

range_ids='[1234, 1230, 1235, 1200]'

# < 500: 8 tasks in range → no degrade
tasks_small=$(cat "$DIR/fixtures/tasks-300.json")
filtered=$(filter_tasks_by_stories "$tasks_small" "$range_ids")
DAILY_TASK_LIMIT=500
result=$(should_degrade_tasks "$filtered")
assert_eq "$result" "false" "8 tasks < 500 → no degrade"

# > 500: 510 tasks in range → degrade
tasks_big=$(cat "$DIR/fixtures/tasks-501.json")
filtered=$(filter_tasks_by_stories "$tasks_big" "$range_ids")
DAILY_TASK_LIMIT=500
result=$(should_degrade_tasks "$filtered")
assert_eq "$result" "true" "510 tasks > 500 → degrade"

# Lower threshold: 8 tasks vs limit 5 → degrade
DAILY_TASK_LIMIT=5
result=$(should_degrade_tasks "$(filter_tasks_by_stories "$tasks_small" "$range_ids")")
assert_eq "$result" "true" "8 tasks > limit 5 → degrade"

test_end
