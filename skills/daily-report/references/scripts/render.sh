#!/usr/bin/env bash
# Aggregated JSON → Markdown renderer (design §6.1).
# Depends on render_bar from progress.sh and task_type_label from collect-tasks.sh.

# Extract just the emoji from a task_type_label string (first Unicode char cluster).
# E.g. "💻 开发" → "💻"
_task_type_emoji() {
  task_type_label "$1" | awk '{print $1}'
}

# Render a single story heading line.
# Input: $1 = story JSON object
_render_story_line() {
  local story=$1
  local id title stage opened_by assigned pct src bar src_label extra

  id=$(echo "$story" | jq -r '.id')
  title=$(echo "$story" | jq -r '.title')
  stage=$(echo "$story" | jq -r '.stage')
  opened_by=$(echo "$story" | jq -r '.openedBy')
  assigned=$(echo "$story" | jq -r '.assignedTo // ""')
  pct=$(echo "$story" | jq -r '.progress.value')
  src=$(echo "$story" | jq -r '.progress.source')
  bar=$(render_bar "$pct")

  case "$src" in
    hours) src_label="工时" ;;
    count) src_label="数量" ;;
    stage) src_label="阶段" ;;
    *)     src_label="$src" ;;
  esac

  extra=""
  if [ "$stage" = "wait" ] && [ -z "$assigned" ]; then
    extra=" · 未分配负责人"
  elif [ "$stage" = "wait" ]; then
    extra=" · 已分配 @${assigned},任务未创建"
  fi

  echo "##### [[S${id}]] ${title} · 创建人 @${opened_by} · 阶段 ${stage} · 进度 ${bar} ${pct}%(${src_label})${extra}"
}

# Render a single task list item.
# Input: $1 = task JSON object
_render_task_line() {
  local task=$1
  local id name type status assigned consumed left label emoji status_emoji hours_info

  id=$(echo "$task" | jq -r '.id')
  name=$(echo "$task" | jq -r '.name')
  type=$(echo "$task" | jq -r '.type')
  status=$(echo "$task" | jq -r '.status')
  assigned=$(echo "$task" | jq -r '.assignedTo')
  consumed=$(echo "$task" | jq -r '.consumed')
  left=$(echo "$task" | jq -r '.left')

  # Use full label (emoji + Chinese name) once; do not duplicate emoji standalone.
  label=$(task_type_label "$type")

  case "$status" in
    wait)         status_emoji="⏸" ;;
    doing)        status_emoji="🔄" ;;
    done|closed)  status_emoji="✅" ;;
    pause)        status_emoji="⏸" ;;
    *)            status_emoji="❓" ;;
  esac

  hours_info=""
  if [ "$status" = "doing" ]; then
    hours_info=" (已耗 ${consumed}h / 剩余 ${left}h)"
  fi

  echo "- ${label} [[T${id}]] ${name} · 执行人 @${assigned} · ${status_emoji} ${status}${hours_info}"
}

# Render a single Bug table row.
# Input: $1 = bug JSON object
_render_bug_row() {
  local bug=$1
  local id title sev opened_by assigned status today_event status_label today_cell

  id=$(echo "$bug" | jq -r '.id')
  title=$(echo "$bug" | jq -r '.title')
  sev=$(echo "$bug" | jq -r '.severity')
  opened_by=$(echo "$bug" | jq -r '.openedBy')
  assigned=$(echo "$bug" | jq -r '.assignedTo')
  status=$(echo "$bug" | jq -r '.status')
  today_event=$(echo "$bug" | jq -r '.today_event // ""')

  case "$status" in
    active)    status_label="🆕 active" ;;
    confirmed) status_label="🔍 confirmed" ;;
    resolved)  status_label="🔄 resolved 待验" ;;
    closed)    status_label="❌ closed" ;;
    postponed) status_label="⏭️ postponed" ;;
    *)         status_label="❓ $status" ;;
  esac

  today_cell="${today_event:+✅ ${today_event}}"
  echo "| [[B${id}]] | ${title} | ${sev} | @${opened_by} | @${assigned} | ${status_label} | ${today_cell} |"
}

# Render the per-product story summary block (design §6.1).
# Input: $1 = product JSON (with stories.* and tasks already injected per story)
_render_story_summary() {
  local prod=$1
  local in_p t_done unas idle total_tasks task_breakdown progress_dist workload blockers
  in_p=$(echo "$prod" | jq '.stories.in_progress | length')
  t_done=$(echo "$prod" | jq '.stories.today_done | length')
  unas=$(echo "$prod" | jq '.stories.unassigned | length')
  idle=$(echo "$prod" | jq '.stories.idle | length')

  # Task breakdown by type (only in_progress stories carry .tasks)
  total_tasks=$(echo "$prod" | jq '[.stories.in_progress[]?.tasks[]?] | length')
  task_breakdown=$(echo "$prod" | jq -r '
    [.stories.in_progress[]?.tasks[]?.type]
    | group_by(.) | map({type: .[0], count: length}) | sort_by(-.count)
    | map(
        (.type | (
          if . == "design" then "📐 设计"
          elif . == "devel" then "💻 开发"
          elif . == "test" then "🧪 测试"
          elif . == "study" then "🔍 研究"
          elif . == "discuss" then "💬 讨论"
          elif . == "ui" then "🎨 UI"
          elif . == "talk" then "📞 沟通"
          elif . == "request" then "📌 需求"
          elif . == "affair" then "📝 事务"
          elif . == "others" then "🔧 其他"
          elif . == "normal" then "📋 普通"
          else "❓ \(.)" end
        )) + " " + (.count | tostring)
      )
    | join(" / ")
  ')

  # Progress distribution across all displayed stories (4 buckets)
  progress_dist=$(echo "$prod" | jq -r '
    [(.stories.in_progress[]?, .stories.today_done[]?, .stories.unassigned[]?, .stories.idle[]?) | .progress.value]
    | (map(select(. <= 30)) | length) as $b1
    | (map(select(. > 30 and . <= 70)) | length) as $b2
    | (map(select(. > 70 and . < 100)) | length) as $b3
    | (map(select(. >= 100)) | length) as $b4
    | "0-30% \($b1) / 31-70% \($b2) / 71-99% \($b3) / 100% \($b4)"
  ')

  # Person workload (top 5 by in-progress task count)
  workload=$(echo "$prod" | jq -r '
    [.stories.in_progress[]?.tasks[]?
     | select(.status != "done" and .status != "closed")
     | .assignedTo]
    | map(select(. != null and . != ""))
    | group_by(.) | map({who: .[0], n: length}) | sort_by(-.n) | .[0:5]
    | map("@\(.who) \(.n)") | join(" / ")
  ')

  # Today blockers: deadline date < today and task not done
  local today_str
  today_str=$(date "+%Y-%m-%d")
  blockers=$(echo "$prod" | jq -r --arg t "$today_str" '
    [.stories.in_progress[]?.tasks[]?
     | select(.deadline != null and .deadline != "" and (.deadline | .[0:10]) < $t)
     | select(.status != "done" and .status != "closed")
     | "[[T\(.id)]] deadline \(.deadline | .[0:10])"]
    | if length == 0 then "无" else .[0:3] | join("; ") end
  ')

  cat <<EOF

**📊 需求小结**
- 进行中 ${in_p} / 今日完成 ${t_done} / 未分配 ${unas} / 未执行 ${idle}
- 关联任务 ${total_tasks}:${task_breakdown:-(无)}
- 进度分布:${progress_dist}
- 人员工作量(进行中任务数):${workload:-(无)}
- 今日卡点:${blockers}

EOF
}

# Render the per-product bug summary block (design §6.1).
# Input: $1 = product JSON
_render_bug_summary() {
  local prod=$1
  local total snap_breakdown sev_dist top_handlers today_n today_r today_c
  total=$(echo "$prod" | jq '.bugs.all // [] | length')
  snap_breakdown=$(echo "$prod" | jq -r '
    .bugs.snapshot
    | "待处理 \(."新增/未处理" | length) / 处理中 \(."处理中" | length) / 已解决待验 \(."已解决待验" | length) / 已关闭 \(."已关闭" | length)"
  ')
  sev_dist=$(echo "$prod" | jq -r '
    [.bugs.all[]?.severity] | group_by(.) | map({s: .[0], n: length}) | sort_by(.s)
    | map("\(.s)=\(.n)") | join(" / ")
  ')
  top_handlers=$(echo "$prod" | jq -r '
    [.bugs.all[]? | select(.assignedTo != null and .assignedTo != "") | .assignedTo]
    | group_by(.) | map({who: .[0], n: length}) | sort_by(-.n) | .[0:3]
    | map("@\(.who) \(.n)") | join(" / ")
  ')
  today_n=$(echo "$prod" | jq '.bugs.today."新建" | length')
  today_r=$(echo "$prod" | jq '.bugs.today."解决" | length')
  today_c=$(echo "$prod" | jq '.bugs.today."关闭" | length')

  cat <<EOF

**📊 Bug 小结**
- 总 ${total}(${snap_breakdown})
- 严重分布:${sev_dist:-(无)}
- 处理人 TOP3:${top_handlers:-(无)}
- 今日动态:新增 ${today_n} / 解决 ${today_r} / 关闭 ${today_c}

EOF
}

# Main entry point: render aggregated JSON into a Markdown daily report.
# Input:  $1 = path to aggregated JSON file
# Output: Markdown text on stdout
render_markdown() {
  local agg_file=$1
  local agg
  agg=$(cat "$agg_file")

  local date_str products_list now_iso
  date_str=$(echo "$agg" | jq -r '.date')
  products_list=$(echo "$agg" | jq -c '[.products[].product.id]')
  now_iso=$(date "+%Y-%m-%dT%H:%M:%S+08:00")

  # --- Frontmatter ---
  cat <<EOF
---
created: ${now_iso}
updated: ${now_iso}
type: daily-report
date: ${date_str}
products: ${products_list}
status: published
tags: [日报, 禅道, 产研日报]
---

# 产研日报 · ${date_str}

EOF

  # --- Overview ---
  local in_p t_done unas idle bg_total bg_new bg_res bg_cls total_active
  in_p=$(echo "$agg" | jq -r '.overview.in_progress')
  t_done=$(echo "$agg" | jq -r '.overview.today_done')
  unas=$(echo "$agg" | jq -r '.overview.unassigned')
  idle=$(echo "$agg" | jq -r '.overview.idle')
  bg_total=$(echo "$agg" | jq -r '.overview.bugs_total')
  bg_new=$(echo "$agg" | jq -r '.overview.bugs_today_new')
  bg_res=$(echo "$agg" | jq -r '.overview.bugs_today_res')
  bg_cls=$(echo "$agg" | jq -r '.overview.bugs_today_cls')
  total_active=$((in_p + t_done + unas + idle))

  cat <<EOF
## 概览

- 需求:进行中 ${in_p} / 今日完成 ${t_done} / 未分配 ${unas} / 未执行 ${idle}(共 ${total_active} 个活跃需求)
- Bug:总 ${bg_total},今日 +${bg_new} / 解决 ${bg_res} / 关闭 ${bg_cls}

---

EOF

  # --- Per-product sections ---
  local product_count
  product_count=$(echo "$agg" | jq '.products | length')

  for ((i=0; i<product_count; i++)); do
    local prod pid pname
    prod=$(echo "$agg" | jq ".products[$i]")
    pid=$(echo "$prod" | jq -r '.product.id')
    pname=$(echo "$prod" | jq -r '.product.name')

    echo "## 产品 ${pname} · #${pid}"
    echo
    echo "### 📋 需求处理情况"
    echo

    # In-progress stories
    local in_progress_count
    in_progress_count=$(echo "$prod" | jq '.stories.in_progress | length')
    if [ "$in_progress_count" -gt 0 ]; then
      echo "#### 🔄 进行中"
      echo
      for ((j=0; j<in_progress_count; j++)); do
        local story task_count
        story=$(echo "$prod" | jq ".stories.in_progress[$j]")
        _render_story_line "$story"
        task_count=$(echo "$story" | jq '.tasks | length')
        if [ "$task_count" -gt 0 ]; then
          echo "关联任务:"
          for ((k=0; k<task_count; k++)); do
            _render_task_line "$(echo "$story" | jq ".tasks[$k]")"
          done
        fi
        echo
      done
    fi

    # Today-done stories
    local today_done_count
    today_done_count=$(echo "$prod" | jq '.stories.today_done | length')
    if [ "$today_done_count" -gt 0 ]; then
      echo "#### ✅ 今日完成"
      echo
      for ((j=0; j<today_done_count; j++)); do
        local story
        story=$(echo "$prod" | jq ".stories.today_done[$j]")
        _render_story_line "$story"
      done
      echo
    fi

    # Unassigned stories
    local unassigned_count
    unassigned_count=$(echo "$prod" | jq '.stories.unassigned | length')
    if [ "$unassigned_count" -gt 0 ]; then
      echo "#### ⚠️ 未分配"
      echo
      for ((j=0; j<unassigned_count; j++)); do
        local story
        story=$(echo "$prod" | jq ".stories.unassigned[$j]")
        _render_story_line "$story"
      done
      echo
    fi

    # Idle (assigned but no tasks) stories
    local idle_count
    idle_count=$(echo "$prod" | jq '.stories.idle | length')
    if [ "$idle_count" -gt 0 ]; then
      echo "#### ⏸ 未执行"
      echo
      for ((j=0; j<idle_count; j++)); do
        local story
        story=$(echo "$prod" | jq ".stories.idle[$j]")
        _render_story_line "$story"
      done
      echo
    fi

    # Story summary (design §6.1: 进度分布 + 任务类型分布 + 人员工作量 + 卡点)
    _render_story_summary "$prod"

    # Bug table
    echo "### 🐛 Bug 处理情况"
    echo
    echo "| Bug | 标题 | 严重 | 提报人 | 处理人 | 状态 | 今日动态 |"
    echo "|---|---|---|---|---|---|---|"
    local bug_count
    bug_count=$(echo "$prod" | jq '.bugs.all // [] | length')
    for ((j=0; j<bug_count; j++)); do
      local bug
      bug=$(echo "$prod" | jq ".bugs.all[$j]")
      _render_bug_row "$bug"
    done
    echo

    # Bug summary (design §6.1: 状态总数 + 严重分布 + 处理人 TOP3)
    _render_bug_summary "$prod"
  done

  cat <<'EOF'
---

## 备注
本日报由 Claude Code 基于 zentao-api 自动生成。⚠️ 表示 ~/.zentao-roles.yaml 未覆盖账号。
EOF
}

export -f render_markdown _render_story_line _render_task_line _render_bug_row _task_type_emoji \
          _render_story_summary _render_bug_summary
