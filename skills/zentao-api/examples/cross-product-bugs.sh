#!/usr/bin/env bash
# cross-product-bugs.sh — cross-product resolved bugs in time window (P2 + ?status=all)
#
# Usage:  ./examples/cross-product-bugs.sh START END
#         (START/END as ISO8601 like 2026-05-01T00:00:00Z, or YYYY-MM-DD)
# Env:    ZENTAO_BASE_URL ZENTAO_ACCOUNT ZENTAO_PASSWORD [ZENTAO_ME]

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 START END" >&2
  exit 2
fi

START="$1"
END="$2"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../scripts/zt-functions.sh
source "${SKILL_DIR}/scripts/zt-functions.sh"

zt_init >/dev/null
zt_acquire_token >/dev/null

ME="${ZENTAO_ME:-$(zt_get /user | jq -r .profile.account)}"
PRODUCT_VIEW=$(zt_get /user | jq -r '.profile.view.products' | tr ',' '\n' | sort -u)

if [ -z "$PRODUCT_VIEW" ]; then
  echo '[]'
  exit 0
fi

while IFS= read -r pid; do
  zt_paginate "/products/$pid/bugs?status=all"
done <<< "$PRODUCT_VIEW" \
  | jq -s --arg me "$ME" --arg s "$START" --arg e "$END" '
    def u(f): (if (f|type) == "object" then (f.account // "") else (f // "") end);
    def dt(s): if (s|tostring) == "" or (s|tostring) == null then "" else (s|tostring|.[0:10]) end;
    [.[] | .bugs[]?
     | select(u(.assignedTo) == $me or u(.resolvedBy) == $me)
     | select(dt(.resolvedDate // .openedDate) >= dt($s))
     | select(dt(.resolvedDate // .openedDate) <  dt($e))]
    | unique_by(.id)'
