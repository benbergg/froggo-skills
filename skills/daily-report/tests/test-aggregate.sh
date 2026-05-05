#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/aggregate.sh"

test_start "test-aggregate"

# Prepare 2 product intermediate JSONs
TMP=$(mktemp -d)
cat > "$TMP/p95.json" <<'EOF'
{
  "date": "2026-05-05",
  "product": {"id": 95, "name": "产品 A", "task_limit_exceeded": false, "range_task_count": 5},
  "stories": {
    "in_progress": [{"id": 1234, "title": "...", "stage": "testing"}],
    "today_done":  [{"id": 1200, "title": "..."}],
    "unassigned":  [],
    "idle":        []
  },
  "bugs": {
    "snapshot": {"新增/未处理": [], "处理中": [{"id": 5685}], "已解决待验": [], "已关闭": []},
    "today":    {"新建": [{"id": 5685}], "解决": [], "关闭": []}
  },
  "person_workload": {"qingwa": {"tasks_in_progress": 1}}
}
EOF
cat > "$TMP/p108.json" <<'EOF'
{
  "date": "2026-05-05",
  "product": {"id": 108, "name": "产品 B", "task_limit_exceeded": true, "range_task_count": 600},
  "stories": {
    "in_progress": [{"id": 2001, "title": "..."}],
    "today_done":  [],
    "unassigned":  [{"id": 2010}],
    "idle":        []
  },
  "bugs": {
    "snapshot": {"新增/未处理": [], "处理中": [], "已解决待验": [], "已关闭": []},
    "today":    {"新建": [], "解决": [], "关闭": []}
  },
  "person_workload": {"qingwa": {"tasks_in_progress": 2}, "zhang": {"tasks_in_progress": 1}}
}
EOF

# Aggregate
ROLE_JSON='{"roles":{"pm":["lily"],"dev":["qingwa","zhang"],"qa":["zhao"]},"names":{"qingwa":"青蛙"}}'
agg=$(aggregate "$TMP/p95.json" "$TMP/p108.json" "$ROLE_JSON")

# Overview = sum
assert_eq "$(echo "$agg" | jq '.overview.in_progress')" "2" "in_progress = 1 + 1"
assert_eq "$(echo "$agg" | jq '.overview.today_done')"  "1" "today_done = 1 + 0"
assert_eq "$(echo "$agg" | jq '.overview.unassigned')"  "1" "unassigned = 0 + 1"
assert_eq "$(echo "$agg" | jq '.overview.bugs_today_new')" "1" "bugs new = 1 + 0"

# Product order matches input file order
assert_eq "$(echo "$agg" | jq -r '.products[0].product.id')" "95"  "first product 95"
assert_eq "$(echo "$agg" | jq -r '.products[1].product.id')" "108" "second product 108"

# Global person_workload merge with same-account sum
assert_eq "$(echo "$agg" | jq '.person_workload_global.qingwa.tasks_in_progress')" "3" "qingwa 1+2=3"
assert_eq "$(echo "$agg" | jq '.person_workload_global.zhang.tasks_in_progress')" "1" "zhang 1"

# Roles preserved
assert_eq "$(echo "$agg" | jq -r '.roles.dev[0]')" "qingwa" "roles preserved"

rm -rf "$TMP"
test_end
