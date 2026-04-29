#!/usr/bin/env bash
# zentao-api: bash lib for read-only access to Zentao RESTful API v1.
# Source this file from a skill invocation; functions are intentionally
# pure-bash + curl + jq so they can be unit-tested with bats.

set -o pipefail

# Resolve cache dir lazily so callers can override ZENTAO_CACHE_DIR before use.
zentao_cache_dir() {
  printf '%s' "${ZENTAO_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/zentao}"
}

# --- internal date helpers (BSD/GNU compatible, UTC) ---

_zentao_iso_to_epoch() {
  local s="$1"
  if TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$s" +%s 2>/dev/null; then
    return 0
  fi
  TZ=UTC date -d "$s" +%s
}

_zentao_epoch_to_iso() {
  local e="$1"
  if TZ=UTC date -r "$e" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null; then
    return 0
  fi
  TZ=UTC date -d "@$e" "+%Y-%m-%dT%H:%M:%SZ"
}

_zentao_epoch_to_dow() {
  # Returns Mon=1 ... Sun=7
  local e="$1"
  if TZ=UTC date -j -f "%s" "$e" +%u 2>/dev/null; then
    return 0
  fi
  TZ=UTC date -d "@$e" +%u
}

# Compute UTC week range as Monday 00:00 .. next Monday 00:00 ..
# next-next Monday 00:00. Honors NOW_OVERRIDE for tests.
# Exports: WK_START WK_END NEXT_S NEXT_E
compute_week_range() {
  local now_iso="${NOW_OVERRIDE:-$(TZ=UTC date "+%Y-%m-%dT%H:%M:%SZ")}"
  local now_epoch dow day_epoch mon_epoch
  now_epoch=$(_zentao_iso_to_epoch "$now_iso")
  dow=$(_zentao_epoch_to_dow "$now_epoch")
  day_epoch=$(( now_epoch - now_epoch % 86400 ))
  mon_epoch=$(( day_epoch - (dow - 1) * 86400 ))

  WK_START=$(_zentao_epoch_to_iso "$mon_epoch")
  WK_END=$(_zentao_epoch_to_iso $((mon_epoch + 7*86400)))
  NEXT_S="$WK_END"
  NEXT_E=$(_zentao_epoch_to_iso $((mon_epoch + 14*86400)))
  export WK_START WK_END NEXT_S NEXT_E
}

_zentao_require_env() {
  local missing=()
  [ -z "${ZENTAO_BASE_URL:-}" ] && missing+=("ZENTAO_BASE_URL")
  [ -z "${ZENTAO_ACCOUNT:-}"  ] && missing+=("ZENTAO_ACCOUNT")
  [ -z "${ZENTAO_PASSWORD:-}" ] && missing+=("ZENTAO_PASSWORD")
  if (( ${#missing[@]} > 0 )); then
    printf 'FATAL: missing required env: %s\n' "${missing[*]}" >&2
    return 2
  fi
}

# Acquire a fresh token from POST /tokens, persist to cache, print to stdout.
acquire_token() {
  _zentao_require_env || return $?

  local cache; cache=$(zentao_cache_dir)
  mkdir -p "$cache" && chmod 700 "$cache" 2>/dev/null || true

  local body
  body=$(jq -cn --arg a "$ZENTAO_ACCOUNT" --arg p "$ZENTAO_PASSWORD" \
    '{account:$a,password:$p}')

  local resp
  resp=$(curl -s --noproxy '*' --max-time 20 -X POST "$ZENTAO_BASE_URL/tokens" \
    -H 'Content-Type: application/json' \
    -d "$body") || true

  local token
  token=$(printf '%s' "$resp" | jq -r '.token // empty' 2>/dev/null)
  if [ -z "$token" ]; then
    printf 'FATAL: token acquire failed: %s\n' "$resp" >&2
    return 1
  fi

  local f="$cache/token.json"
  printf '{"token":"%s","acquired_at":"%s"}\n' \
    "$token" "$(TZ=UTC date '+%Y-%m-%dT%H:%M:%SZ')" > "$f"
  chmod 600 "$f"
  printf '%s\n' "$token"
}

# GET <endpoint>; auto-acquires token on first use; on unauthorized, refreshes
# token and retries exactly once. Endpoint may contain a query string.
zentao_call() {
  _zentao_require_env || return $?
  local ep="$1"
  local cache; cache=$(zentao_cache_dir)
  local token_file="$cache/token.json"
  local token=""

  if [ -f "$token_file" ]; then
    token=$(jq -r '.token // empty' "$token_file" 2>/dev/null)
  fi
  if [ -z "$token" ]; then
    token=$(acquire_token) || return $?
  fi

  local url="${ZENTAO_BASE_URL}${ep}"
  local resp
  resp=$(_zentao_curl_get "$url" "$token") || true

  if printf '%s' "$resp" | grep -qi '"error":"[Uu]nauthorized"'; then
    token=$(acquire_token) || return $?
    resp=$(_zentao_curl_get "$url" "$token") || true
  fi

  printf '%s\n' "$resp"
}

# Internal GET wrapper. Strips illegal JSON control chars (kept: \t \n \r),
# because the upstream API leaks raw \b \v \f \x01-\x08 etc. into string
# values and breaks strict JSON parsers like jq.
_zentao_curl_get() {
  local url="$1" token="$2"
  curl -s --noproxy '*' --max-time 20 -X GET "$url" \
    -H "Token: $token" -H "Content-Type: application/json" \
    | LC_ALL=C tr -d '\001-\010\013\014\016-\037'
}

# Paginate over a list endpoint with limit=500. Emits each page's raw body
# concatenated with newlines. Caller is expected to pipe through `jq -s`.
# Safety valve: hard cap at 20 pages (10000 items) to avoid runaway loops on
# misbehaving endpoints (e.g. top-level /tasks with broken paging).
paginate() {
  local ep="$1"
  local p=1 limit=500
  while :; do
    local resp
    resp=$(zentao_call "${ep}?limit=${limit}&page=${p}") || return $?
    printf '%s\n' "$resp"
    local total
    total=$(printf '%s' "$resp" | jq -r '.total // 0' 2>/dev/null)
    [ -z "$total" ] && total=0
    if [ "$(( p * limit ))" -ge "$total" ]; then
      break
    fi
    p=$(( p + 1 ))
    if [ "$p" -gt 20 ]; then
      break
    fi
  done
}

# Returns the user profile JSON (incl. profile.view ranges) with a 24h TTL
# file cache to avoid repeatedly hitting /user across calls in the same day.
get_user_cached() {
  local cache; cache=$(zentao_cache_dir)
  local f="$cache/user.json"
  if [ -f "$f" ]; then
    local mtime now age
    mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")
    now=$(date +%s)
    age=$(( now - mtime ))
    if [ "$age" -lt 86400 ]; then
      cat "$f"
      return 0
    fi
  fi
  mkdir -p "$cache" && chmod 700 "$cache" 2>/dev/null || true
  local resp
  resp=$(zentao_call /user) || return $?
  printf '%s\n' "$resp" > "$f"
  chmod 600 "$f"
  printf '%s\n' "$resp"
}
