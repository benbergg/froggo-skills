#!/usr/bin/env bash
# zt-functions.sh — Zentao API v1 toolkit
#
# Usage:
#   source /path/to/zt-functions.sh
#   zt_init && zt_acquire_token >/dev/null
#   zt_get /user
#
# Required env: ZENTAO_BASE_URL ZENTAO_ACCOUNT ZENTAO_PASSWORD
# Optional env: ZENTAO_ME ZENTAO_CACHE_DIR
#
# Functions:
#   S1 zt_init           — validate env + cache dir
#   S2 zt_acquire_token  — POST /tokens, write 600 token.json
#   S3 zt_get            — GET wrapper (sanitize + 401 retry)
#   S4 zt_write          — POST/PUT wrapper (sanitize + 401 retry)
#   S5 zt_paginate       — page loop with 20-page safety valve
#   S6 zt_week_range     — Mon 00:00 ~ next Mon 00:00 UTC (BSD/GNU compat)
#
# Safety (rationale → references/troubleshooting.md):
#   * --noproxy '*'  (local Clash/Surge bypass returns 400)
#   * tr -d '\000-\037'  (Zentao embeds raw C0 ctrl chars in JSON strings)
#   * chmod 600 token.json, chmod 700 $ZT_CACHE, never logged

# === S1 zt_init ===
zt_init() {
  setopt local_options typeset_silent 2>/dev/null || true
  local missing=()
  [ -z "${ZENTAO_BASE_URL:-}" ] && missing+=("ZENTAO_BASE_URL")
  [ -z "${ZENTAO_ACCOUNT:-}"  ] && missing+=("ZENTAO_ACCOUNT")
  [ -z "${ZENTAO_PASSWORD:-}" ] && missing+=("ZENTAO_PASSWORD")
  if (( ${#missing[@]} > 0 )); then
    printf 'FATAL: missing required env: %s\n' "${missing[*]}" >&2
    return 2
  fi
  ZT_CACHE="${ZENTAO_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/zentao}"
  mkdir -p "$ZT_CACHE" && chmod 700 "$ZT_CACHE" 2>/dev/null || true
  export ZT_CACHE
}

# === S2 zt_acquire_token ===
zt_acquire_token() {
  setopt local_options typeset_silent 2>/dev/null || true
  zt_init || return $?
  local body resp token
  body=$(jq -cn --arg a "$ZENTAO_ACCOUNT" --arg p "$ZENTAO_PASSWORD" \
    '{account:$a,password:$p}')
  resp=$(curl -s --noproxy '*' --max-time 20 -X POST "$ZENTAO_BASE_URL/tokens" \
    -H 'Content-Type: application/json' -d "$body") || true
  token=$(printf '%s' "$resp" | jq -r '.token // empty' 2>/dev/null)
  if [ -z "$token" ]; then
    printf 'FATAL: token acquire failed: %s\n' "$resp" >&2
    return 1
  fi
  local f="$ZT_CACHE/token.json"
  jq -cn --arg t "$token" --arg ts "$(TZ=UTC date '+%Y-%m-%dT%H:%M:%SZ')" \
    '{token:$t,acquired_at:$ts}' > "$f"
  chmod 600 "$f"
  printf '%s\n' "$token"
}

# === S3 zt_get ===
zt_get() {
  setopt local_options typeset_silent 2>/dev/null || true
  zt_init || return $?
  local ep="$1"
  local f="$ZT_CACHE/token.json"
  local token=""
  [ -f "$f" ] && token=$(jq -r '.token // empty' "$f" 2>/dev/null)
  [ -z "$token" ] && token=$(zt_acquire_token) || true
  [ -z "$token" ] && return 1

  local url="${ZENTAO_BASE_URL}${ep}"
  local resp
  resp=$(curl -s --noproxy '*' --max-time 20 -X GET "$url" \
    -H "Token: $token" -H "Content-Type: application/json" \
    | LC_ALL=C tr -d '\000-\037') || true

  if printf '%s' "$resp" | grep -qi '"error":"[Uu]nauthorized"'; then
    token=$(zt_acquire_token) || return 1
    resp=$(curl -s --noproxy '*' --max-time 20 -X GET "$url" \
      -H "Token: $token" -H "Content-Type: application/json" \
      | LC_ALL=C tr -d '\000-\037') || true
  fi
  printf '%s\n' "$resp"
}

# === S4 zt_write ===
zt_write() {
  setopt local_options typeset_silent 2>/dev/null || true
  zt_init || return $?
  local method="$1" ep="$2" body="$3"
  case "$method" in POST|PUT) ;; *)
    printf 'FATAL: unsupported method: %s\n' "$method" >&2; return 2 ;;
  esac
  local f="$ZT_CACHE/token.json"
  local token=""
  [ -f "$f" ] && token=$(jq -r '.token // empty' "$f" 2>/dev/null)
  [ -z "$token" ] && token=$(zt_acquire_token) || true
  [ -z "$token" ] && return 1

  local url="${ZENTAO_BASE_URL}${ep}"
  local resp
  resp=$(curl -s --noproxy '*' --max-time 20 -X "$method" "$url" \
    -H "Token: $token" -H "Content-Type: application/json" \
    -d "$body" | LC_ALL=C tr -d '\000-\037') || true

  if printf '%s' "$resp" | grep -qi '"error":"[Uu]nauthorized"'; then
    token=$(zt_acquire_token) || return 1
    resp=$(curl -s --noproxy '*' --max-time 20 -X "$method" "$url" \
      -H "Token: $token" -H "Content-Type: application/json" \
      -d "$body" | LC_ALL=C tr -d '\000-\037') || true
  fi
  printf '%s\n' "$resp"
}

# === S5 zt_paginate ===
zt_paginate() {
  setopt local_options typeset_silent 2>/dev/null || true
  local ep="$1"
  local p=1 limit=500
  while :; do
    local sep='?'
    [[ "$ep" == *'?'* ]] && sep='&'
    local resp
    resp=$(zt_get "${ep}${sep}limit=${limit}&page=${p}") || return $?
    printf '%s\n' "$resp"
    local total
    total=$(printf '%s' "$resp" | jq -r '.total // 0' 2>/dev/null)
    [ -z "$total" ] && total=0
    if [ "$(( p * limit ))" -ge "$total" ]; then
      break
    fi
    p=$(( p + 1 ))
    if [ "$p" -gt 20 ]; then
      printf 'WARN: zt_paginate hit 20-page safety valve at %s\n' "$ep" >&2
      break
    fi
  done
}

# === S6 zt_week_range ===
_zt_iso2ep() { TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null \
              || TZ=UTC date -d "$1" +%s; }
_zt_ep2iso() { TZ=UTC date -r "$1" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
              || TZ=UTC date -d "@$1" "+%Y-%m-%dT%H:%M:%SZ"; }
_zt_ep2dow() { TZ=UTC date -j -f "%s" "$1" +%u 2>/dev/null \
              || TZ=UTC date -d "@$1" +%u; }

zt_week_range() {
  setopt local_options typeset_silent 2>/dev/null || true
  local now_iso="${NOW_OVERRIDE:-$(TZ=UTC date "+%Y-%m-%dT%H:%M:%SZ")}"
  local now_ep dow day_ep mon_ep
  now_ep=$(_zt_iso2ep "$now_iso")
  dow=$(_zt_ep2dow "$now_ep")
  day_ep=$(( now_ep - now_ep % 86400 ))
  mon_ep=$(( day_ep - (dow - 1) * 86400 ))

  WK_START=$(_zt_ep2iso "$mon_ep")
  WK_END=$(_zt_ep2iso $((mon_ep + 7*86400)))
  NEXT_S="$WK_END"
  NEXT_E=$(_zt_ep2iso $((mon_ep + 14*86400)))
  export WK_START WK_END NEXT_S NEXT_E
}
