#!/usr/bin/env bash
# End-to-end test: run.sh against mock Zentao API (no real credentials needed).
# Verifies the full pipeline: collect -> classify -> aggregate -> render -> evaluate.

DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"

test_start "test-e2e-run"

# Isolated temp knowledge library
TMP_KB=$(mktemp -d -t e2e-kb.XXXXXX)
trap 'rm -rf "$TMP_KB"' EXIT

export ZT_FUNCTIONS_OVERRIDE="$DIR/e2e-mocks/zt-functions.sh"
export KNOWLEDGE_LIB="$TMP_KB"
export ZENTAO_PRODUCTS=95
export DAILY_API_BUDGET=600
export DAILY_TASK_LIMIT=500

# Required by zt_init even though mock no-ops; provide dummies so set -u doesn't fire.
export ZENTAO_BASE_URL="mock://e2e"
export ZENTAO_ACCOUNT="e2e-account"
export ZENTAO_PASSWORD="e2e-password"

# Run the full pipeline
RUN_OUTPUT=$(bash "$DIR/../references/scripts/run.sh" manual 2>&1)
RUN_RC=$?

assert_eq "$RUN_RC" "0" "run.sh exits 0"
assert_contains "$RUN_OUTPUT" "evaluation score:" "evaluation runs"
assert_contains "$RUN_OUTPUT" "daily-report done" "completion banner"

# Verify output file landed in temp KB
TODAY=$(date "+%Y-%m-%d")
OUTPUT_FILE="$TMP_KB/05-Reports/daily/${TODAY}.md"
[ -f "$OUTPUT_FILE" ] && _PASS=$((_PASS + 1)) || {
  _FAIL=$((_FAIL + 1))
  echo "  ❌ output file missing: $OUTPUT_FILE" >&2
}

if [ -f "$OUTPUT_FILE" ]; then
  MD=$(cat "$OUTPUT_FILE")

  # Frontmatter
  assert_contains "$MD" "type: daily-report" "frontmatter type"
  assert_contains "$MD" "products: [95]" "frontmatter products"

  # Real product name (from /products/95 mock fixture)
  assert_contains "$MD" "## 产品 E2E-Product · #95" "real product name"

  # Story buckets
  assert_contains "$MD" "#### 🔄 进行中" "in_progress section"
  assert_contains "$MD" "#### ⚠️ 未分配" "unassigned section"
  assert_contains "$MD" "#### ⏸ 未执行" "idle section"
  assert_contains "$MD" "[[S9001]]" "in_progress story link"
  assert_contains "$MD" "[[S9002]]" "unassigned story link"
  assert_contains "$MD" "[[S9003]]" "idle story link"

  # Task rendered with type label and parent.children[] flattened
  assert_contains "$MD" "💻 开发 [[T8001]]" "devel task with label"
  assert_contains "$MD" "🧪 测试 [[T8002]]" "test child task flattened"

  # Bug filter: historical active kept; historical resolved excluded
  assert_contains "$MD" "[[B7001]]" "historical active bug present"
  assert_not_contains "$MD" "[[B7002]]" "historical resolved bug filtered out"

  # Overview counts: in_progress 1 / today_done 0 / unassigned 1 / idle 1
  assert_contains "$MD" "进行中 1" "overview in_progress"
  assert_contains "$MD" "未分配 1" "overview unassigned"
  assert_contains "$MD" "未执行 1" "overview idle"

  # Bug count: 1 historical active in scope (resolved filtered)
  assert_contains "$MD" "Bug:总 1" "overview bugs in scope"
fi

test_end
