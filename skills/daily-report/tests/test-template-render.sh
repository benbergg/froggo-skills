#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/progress.sh"
source "$DIR/../references/scripts/collect-tasks.sh"
source "$DIR/../references/scripts/render.sh"

test_start "test-template-render"

# Given an aggregated JSON, render Markdown and verify structure
TMP=$(mktemp -d)
cat > "$TMP/agg.json" <<'EOF'
{
  "date": "2026-05-05",
  "products": [
    {
      "product": {"id": 95, "name": "产品 A", "task_limit_exceeded": false, "range_task_count": 3},
      "stories": {
        "in_progress": [
          {
            "id": 1234, "title": "性能优化", "stage": "testing",
            "openedBy": "lily", "assignedTo": "qingwa",
            "progress": {"value": 80, "source": "hours"},
            "tasks": [
              {"id": 8001, "name": "实现", "type": "devel", "status": "doing", "assignedTo": "qingwa", "consumed": 8, "left": 4, "deadline": "2026-05-04"}
            ],
            "today_actions": []
          }
        ],
        "today_done": [],
        "unassigned": [{"id": 1240, "title": "调研", "stage": "wait", "openedBy": "lily", "assignedTo": "", "progress": {"value": 0, "source": "stage"}}],
        "idle":       [{"id": 1245, "title": "导出", "stage": "wait", "openedBy": "wang", "assignedTo": "qingwa", "progress": {"value": 0, "source": "stage"}}]
      },
      "bugs": {
        "snapshot": {"新增/未处理": [], "处理中": [], "已解决待验": [], "已关闭": []},
        "today":    {"新建": [], "解决": [], "关闭": []},
        "all":      [{"id": 5685, "title": "报错", "severity": 1, "openedBy": "zhao", "assignedTo": "zhang", "status": "active", "today_event": "今日新增"}]
      }
    }
  ],
  "overview": {"in_progress": 1, "today_done": 0, "unassigned": 1, "idle": 1, "bugs_total": 1, "bugs_today_new": 1, "bugs_today_res": 0, "bugs_today_cls": 0},
  "person_workload_global": {},
  "roles": {"pm": ["lily", "wang"], "dev": ["qingwa", "zhang"], "qa": ["zhao"]},
  "names": {"qingwa": "青蛙"}
}
EOF

md=$(render_markdown "$TMP/agg.json")

# Frontmatter required fields
assert_contains "$md" "type: daily-report" "frontmatter type"
assert_contains "$md" "date: 2026-05-05" "frontmatter date"
assert_contains "$md" "products: [95]" "frontmatter products"
assert_contains "$md" "tags:" "frontmatter tags"

# Overview section
assert_contains "$md" "## 概览" "overview section"
assert_contains "$md" "进行中 1" "overview in_progress"

# Product section
assert_contains "$md" "## 产品 产品 A · #95" "product section"
assert_contains "$md" "### 📋 需求处理情况" "story section"
assert_contains "$md" "[[S1234]]" "wikilink S1234"
assert_contains "$md" "💻 开发 [[T8001]]" "task with devel label"
assert_contains "$md" "[████████░░] 80%" "progress bar"
assert_contains "$md" "(工时)" "progress source"

# Four-state labels
assert_contains "$md" "#### 🔄 进行中" "in_progress label"
assert_contains "$md" "#### ⚠️ 未分配" "unassigned label"
assert_contains "$md" "#### ⏸ 未执行" "idle label"

# Bug table
assert_contains "$md" "### 🐛 Bug 处理情况" "bug section"
assert_contains "$md" "| Bug | 标题 |" "bug table header"
assert_contains "$md" "[[B5685]]" "bug wikilink"

# No unknown accounts in this test (role-map covers all accounts)
assert_not_contains "$md" "@account_x" "no unknown sample"

rm -rf "$TMP"
test_end
