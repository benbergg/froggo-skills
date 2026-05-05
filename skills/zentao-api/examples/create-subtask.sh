#!/usr/bin/env bash
# create-subtask.sh — create a subtask in 2 API calls (POST + PUT)
#
# Usage:  ./examples/create-subtask.sh EXEC_ID PARENT_ID NAME DEADLINE [ASSIGNEE]
#         DEADLINE: YYYY-MM-DD
#         ASSIGNEE: defaults to $ZENTAO_ACCOUNT
# Env:    ZENTAO_BASE_URL ZENTAO_ACCOUNT ZENTAO_PASSWORD

set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "Usage: $0 EXEC_ID PARENT_ID NAME DEADLINE [ASSIGNEE]" >&2
  exit 2
fi

EXEC_ID="$1"
PARENT_ID="$2"
NAME="$3"
DEADLINE="$4"
ASSIGNEE="${5:-$ZENTAO_ACCOUNT}"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../scripts/zt-functions.sh
source "${SKILL_DIR}/scripts/zt-functions.sh"

zt_init >/dev/null
zt_acquire_token >/dev/null

# Step 1: create top-level task (parent field is ignored at creation time)
TODAY=$(TZ=UTC date '+%Y-%m-%d')
RESP=$(zt_write POST "/executions/$EXEC_ID/tasks" "$(jq -cn \
  --arg n "$NAME" --arg a "$ASSIGNEE" --arg s "$TODAY" --arg d "$DEADLINE" \
  '{name:$n, assignedTo:$a, estStarted:$s, deadline:$d, type:"devel", estimate:0.1}')")

NEW_ID=$(echo "$RESP" | jq -r '.id // empty')
if [ -z "$NEW_ID" ] || [ "$NEW_ID" = "null" ]; then
  echo "FATAL: create failed: $RESP" >&2
  exit 1
fi

# Step 2: set parent relationship
zt_write PUT "/tasks/$NEW_ID" "$(jq -cn --argjson p "$PARENT_ID" '{parent:$p}')" >/dev/null

# Verification: read back and confirm .parent
PARENT_BACK=$(zt_get "/tasks/$NEW_ID" | jq -r '.parent // 0')
if [ "$PARENT_BACK" != "$PARENT_ID" ]; then
  echo "WARN: parent verify failed: expected=$PARENT_ID got=$PARENT_BACK" >&2
fi

echo "$NEW_ID"
