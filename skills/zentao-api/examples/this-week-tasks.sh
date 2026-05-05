#!/usr/bin/env bash
# this-week-tasks.sh — query this week's completed tasks (P1 application)
#
# Usage:  ./examples/this-week-tasks.sh
# Env:    ZENTAO_BASE_URL ZENTAO_ACCOUNT ZENTAO_PASSWORD [ZENTAO_ME]

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../scripts/zt-functions.sh
source "${SKILL_DIR}/scripts/zt-functions.sh"

zt_init >/dev/null
zt_acquire_token >/dev/null
zt_week_range  # exports WK_START WK_END

ME="${ZENTAO_ME:-$(zt_get /user | jq -r .profile.account)}"

USER=$(zt_get /user)
SPRINT_VIEW=$(echo "$USER" | jq -r '.profile.view.sprints' | tr ',' '\n' | sort -u)
DOING=$(zt_get "/executions?status=doing&limit=500" | jq -r '.executions[].id' | sort -u)
MY_DOING=$(comm -12 <(echo "$SPRINT_VIEW") <(echo "$DOING"))

if [ -z "$MY_DOING" ]; then
  echo '[]'
  exit 0
fi

while IFS= read -r sid; do
  zt_paginate "/executions/$sid/tasks"
done <<< "$MY_DOING" \
  | jq -s --arg me "$ME" --arg s "$WK_START" --arg e "$WK_END" '
    def u(f): (if (f|type) == "object" then (f.account // "") else (f // "") end);
    def dt(s): if (s|tostring) == "" or (s|tostring) == null then "" else (s|tostring|.[0:10]) end;
    ([.[].tasks[]?] + [.[].tasks[]?.children[]?])
    | map(select(
        (u(.assignedTo) == $me or u(.finishedBy) == $me)
        and dt(.finishedDate) >= dt($s)
        and dt(.finishedDate) <  dt($e)
      ) | {id, name, status,
           execution: (.execution // .executionID // null),
           finishedDate,
           assignedTo: u(.assignedTo), finishedBy: u(.finishedBy)})
    | unique_by(.id)'
