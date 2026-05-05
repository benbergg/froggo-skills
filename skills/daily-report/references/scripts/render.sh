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
    active)   status_label="🆕 active" ;;
    resolved) status_label="🔄 resolved 待验" ;;
    closed)   status_label="❌ closed" ;;
    *)        status_label="$status" ;;
  esac

  today_cell="${today_event:+✅ ${today_event}}"
  echo "| [[B${id}]] | ${title} | ${sev} | @${opened_by} | @${assigned} | ${status_label} | ${today_cell} |"
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
  done

  cat <<'EOF'
---

## 备注
本日报由 Claude Code 基于 zentao-api 自动生成。⚠️ 表示 ~/.zentao-roles.yaml 未覆盖账号。
EOF
}

export -f render_markdown _render_story_line _render_task_line _render_bug_row _task_type_emoji
