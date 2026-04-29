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

_zentao_curl_write() {
  # $1=method (POST|PUT)  $2=url  $3=token  $4=body
  curl -s --noproxy '*' --max-time 20 -X "$1" "$2" \
    -H "Token: $3" -H "Content-Type: application/json" \
    -d "$4" \
    | LC_ALL=C tr -d '\001-\010\013\014\016-\037'
}

_zentao_write() {
  # Shared body of zentao_post / zentao_put.
  # $1=method  $2=endpoint  $3=body_json
  _zentao_require_env || return $?
  local method="$1" ep="$2" body="$3"
  case "$method" in POST|PUT) ;; *)
    printf 'FATAL: unsupported method: %s\n' "$method" >&2; return 2 ;;
  esac

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
  resp=$(_zentao_curl_write "$method" "$url" "$token" "$body") || true

  if printf '%s' "$resp" | grep -qi '"error":"[Uu]nauthorized"'; then
    token=$(acquire_token) || return $?
    resp=$(_zentao_curl_write "$method" "$url" "$token" "$body") || true
  fi

  printf '%s\n' "$resp"
}

# POST <endpoint> <body_json>. Auto-acquires token; on 401 retries exactly once.
zentao_post() { _zentao_write POST "$1" "$2"; }

# PUT <endpoint> <body_json>. Auto-acquires token; on 401 retries exactly once.
zentao_put()  { _zentao_write PUT  "$1" "$2"; }

# Create a task in the given execution.
#   $1: execution_id (required, numeric)
#   $2: body_json    (required, valid JSON; must include name + estStarted +
#                     deadline at minimum per Zentao's validation)
# Returns the created task JSON on stdout; non-zero on validation/HTTP error.
zentao_create_task() {
  local eid="$1" body="$2"
  if [ -z "$eid" ]; then
    echo "FATAL: zentao_create_task: execution_id required" >&2
    return 2
  fi
  if [ -z "$body" ]; then
    echo "FATAL: zentao_create_task: body_json required" >&2
    return 2
  fi
  if ! printf '%s' "$body" | jq -e . >/dev/null 2>&1; then
    echo "FATAL: zentao_create_task: body is not valid JSON" >&2
    return 2
  fi
  zentao_post "/executions/${eid}/tasks" "$body"
}

# Create a sub-task and link it to a parent task. Two-step flow because the
# Zentao v1 API silently ignores `parent` on POST; the parent association
# only takes effect through a follow-up PUT.
#   $1: execution_id  (required, numeric)
#   $2: parent_task_id (required, numeric)
#   $3: body_json     (required; any `parent` key in it is stripped before POST
#                      to avoid confusion — the canonical parent is $2)
# Returns the final task JSON (after PUT) on stdout.
zentao_create_subtask() {
  local eid="$1" parent="$2" body="$3"
  if [ -z "$eid" ]; then
    echo "FATAL: zentao_create_subtask: execution_id required" >&2
    return 2
  fi
  if [ -z "$parent" ]; then
    echo "FATAL: zentao_create_subtask: parent_task_id required" >&2
    return 2
  fi
  case "$parent" in
    ''|*[!0-9]*) echo "FATAL: zentao_create_subtask: parent_task_id must be numeric" >&2; return 2 ;;
  esac
  if [ -z "$body" ] || ! printf '%s' "$body" | jq -e . >/dev/null 2>&1; then
    echo "FATAL: zentao_create_subtask: body must be valid JSON" >&2
    return 2
  fi

  # Strip any caller-supplied `parent` from POST body (POST ignores it; we set
  # it explicitly via PUT below to make intent unambiguous).
  local post_body
  post_body=$(printf '%s' "$body" | jq -c 'del(.parent)')

  local created
  created=$(zentao_post "/executions/${eid}/tasks" "$post_body") || return $?
  if printf '%s' "$created" | grep -qi '"error"'; then
    printf 'FATAL: subtask POST failed: %s\n' "$created" >&2
    return 1
  fi
  local new_id
  new_id=$(printf '%s' "$created" | jq -r '.id // empty' 2>/dev/null)
  if [ -z "$new_id" ]; then
    printf 'FATAL: subtask POST returned no id: %s\n' "$created" >&2
    return 1
  fi

  zentao_put "/tasks/${new_id}" "$(jq -cn --argjson p "$parent" '{parent:$p}')"
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
