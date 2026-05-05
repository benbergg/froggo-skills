#!/usr/bin/env bash
# D5: task collection with type emoji map and range-based degrade (design §4.6).

# Map task.type to emoji + Chinese label. Unknown values fall back to ❓ {raw}.
task_type_label() {
  case "$1" in
    design)  echo "📐 设计" ;;
    devel)   echo "💻 开发" ;;
    test)    echo "🧪 测试" ;;
    study)   echo "🔍 研究" ;;
    discuss) echo "💬 讨论" ;;
    ui)      echo "🎨 UI" ;;
    talk)    echo "📞 沟通" ;;
    request) echo "📌 需求" ;;
    affair)  echo "📝 事务" ;;
    others)  echo "🔧 其他" ;;
    *)       echo "❓ $1" ;;
  esac
}

# Filter tasks whose story field is in the given story_id array.
# Excludes tasks with story=0 or story=null (unrelated tasks).
#
# Input:
#   $1  tasks     - JSON array of task objects
#   $2  range_ids - JSON array of story IDs (e.g. [1234, 1230])
filter_tasks_by_stories() {
  local tasks=$1
  local range_ids=$2
  echo "$tasks" | jq --argjson ids "$range_ids" '
    [.[] | select(.story != null and .story != 0 and (.story as $s | $ids | index($s) != null))]
  '
}

# Range-based degrade: returns "true" if task count meets or exceeds DAILY_TASK_LIMIT.
# Defaults to 500 when DAILY_TASK_LIMIT is unset.
#
# Input:
#   $1  range_tasks - JSON array of tasks already filtered to the range
should_degrade_tasks() {
  local range_tasks=$1
  local count
  count=$(echo "$range_tasks" | jq 'length')
  local limit="${DAILY_TASK_LIMIT:-500}"
  if [ "$count" -ge "$limit" ]; then
    echo "true"
  else
    echo "false"
  fi
}

# Production wrapper: product → projects → executions → tasks (with .children[] recursion).
# Depends on retry_with_backoff and zt_paginate (sourced together by run.sh in T11).
#
# Input:
#   $1  pid - product ID
collect_tasks_for_product() {
  local pid=$1
  local projects
  projects=$(retry_with_backoff zt_get "/products/$pid/projects" | jq -r '.projects[].id' | tr '\n' ' ')

  local all_tasks="[]"
  local projectId eid
  for projectId in $projects; do
    local execs
    execs=$(retry_with_backoff zt_get "/projects/$projectId/executions" | jq -r '.executions[].id' | tr '\n' ' ')
    for eid in $execs; do
      local page
      page=$(retry_with_backoff zt_paginate "/executions/$eid/tasks" 100)
      local flat
      flat=$(echo "$page" | jq '[.tasks[]?] + [.tasks[]?.children[]?]')
      all_tasks=$(jq -s 'add' <(echo "$all_tasks") <(echo "$flat"))
    done
  done
  echo "$all_tasks"
}

export -f task_type_label filter_tasks_by_stories should_degrade_tasks collect_tasks_for_product
