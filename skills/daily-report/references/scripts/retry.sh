#!/usr/bin/env bash
# Rate-limit backoff + API budget counter wrapper.
# Uses a temp file to persist the call count across subshell boundaries.

_DAILY_COUNT_FILE="${_DAILY_COUNT_FILE:-$(mktemp -t daily-count.XXXXXX)}"
export _DAILY_COUNT_FILE

# Initialize file from current variable value (default 0)
echo "${API_CALL_COUNT:-0}" > "$_DAILY_COUNT_FILE"

get_api_call_count() {
  if [ -n "${_DAILY_COUNT_FILE:-}" ] && [ -f "$_DAILY_COUNT_FILE" ]; then
    cat "$_DAILY_COUNT_FILE"
  else
    echo "${API_CALL_COUNT:-0}"
  fi
}
export -f get_api_call_count

reset_api_call_count() {
  echo 0 > "${_DAILY_COUNT_FILE:-/dev/null}"
  export API_CALL_COUNT=0
}
export -f reset_api_call_count

retry_with_backoff() {
  # Auto-init count file if not set (survives subshell re-entry)
  if [ -z "${_DAILY_COUNT_FILE:-}" ] || [ ! -f "${_DAILY_COUNT_FILE:-}" ]; then
    _DAILY_COUNT_FILE="$(mktemp -t daily-count.XXXXXX)"
    export _DAILY_COUNT_FILE
    echo "${API_CALL_COUNT:-0}" > "$_DAILY_COUNT_FILE"
  fi

  local max_retries=4
  local backoffs
  if [ -n "${DAILY_BACKOFF_OVERRIDE:-}" ]; then
    read -ra backoffs <<< "$DAILY_BACKOFF_OVERRIDE"
  else
    backoffs=(1 2 4 8)
  fi

  # Read current count from file (handles subshell boundaries)
  local current_count
  current_count=$(cat "$_DAILY_COUNT_FILE" 2>/dev/null || echo "${API_CALL_COUNT:-0}")

  # Budget check before any call
  if [ "$current_count" -ge "${DAILY_API_BUDGET:-600}" ]; then
    echo "BUDGET_EXCEEDED: API_CALL_COUNT=${current_count} >= DAILY_API_BUDGET=${DAILY_API_BUDGET:-600}" >&2
    return 2
  fi

  local attempt=0
  local output
  local rc
  while [ $attempt -lt $max_retries ]; do
    current_count=$(cat "$_DAILY_COUNT_FILE" 2>/dev/null || echo "0")
    current_count=$((current_count + 1))
    echo "$current_count" > "$_DAILY_COUNT_FILE"
    output=$("$@" 2>&1)
    rc=$?
    if [ $rc -eq 0 ]; then
      echo "$output"
      return 0
    fi
    if echo "$output" | grep -qiE 'rate.?limit|429|503'; then
      sleep "${backoffs[$attempt]}"
      attempt=$((attempt + 1))
    else
      echo "$output" >&2
      return 1
    fi
  done
  echo "$output" >&2
  return 1
}

export -f retry_with_backoff
