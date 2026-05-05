#!/usr/bin/env bash
# Rate-limit backoff + API budget counter wrapper.
# Uses a temp file to persist API_CALL_COUNT across subshell boundaries.
# A DEBUG trap inspects BASH_COMMAND to detect explicit resets vs. subshell increments.

export _DAILY_COUNT_FILE="${_DAILY_COUNT_FILE:-$(mktemp /tmp/daily_api_count.XXXXXX)}"

# Initialize file from current variable value
echo "${API_CALL_COUNT:-0}" > "$_DAILY_COUNT_FILE"

# Sync logic:
# - If BASH_COMMAND is an explicit assignment to API_CALL_COUNT, sync file down after it runs.
# - Otherwise, sync var up from file (subshell may have incremented it).
_DAILY_NEXT_CMD_IS_COUNT_ASSIGN=0

_sync_count_to_var() {
  if [ -f "${_DAILY_COUNT_FILE:-}" ]; then
    if [ "${_DAILY_NEXT_CMD_IS_COUNT_ASSIGN:-0}" -eq 1 ]; then
      # Previous command was an assignment; file was already updated by that command's hook.
      _DAILY_NEXT_CMD_IS_COUNT_ASSIGN=0
    else
      # Sync var up from file (subshell increments)
      API_CALL_COUNT=$(cat "$_DAILY_COUNT_FILE")
      export API_CALL_COUNT
    fi
    # Check if the CURRENT upcoming command assigns API_CALL_COUNT
    if [[ "${BASH_COMMAND:-}" == *"API_CALL_COUNT="* ]]; then
      _DAILY_NEXT_CMD_IS_COUNT_ASSIGN=1
    fi
  fi
}

# Post-assignment hook: when API_CALL_COUNT is assigned, update file to match.
# We achieve this by re-checking after the assign via the next DEBUG trap fire.
# Actually: we use PROMPT_COMMAND to detect — but that only runs at prompts.
# Better: since DEBUG fires before each simple command, we catch the assign command
# and then on the NEXT debug trap fire, we write the new value to file.

_sync_count_after_assign() {
  # Runs at the beginning of the trap, after the previous assign completed
  if [ "${_DAILY_PENDING_SYNC_DOWN:-0}" -eq 1 ]; then
    echo "${API_CALL_COUNT:-0}" > "$_DAILY_COUNT_FILE"
    _DAILY_PENDING_SYNC_DOWN=0
  fi
}

_daily_debug_trap() {
  if [ -f "${_DAILY_COUNT_FILE:-}" ]; then
    # Step 1: handle pending sync-down from previous assignment
    if [ "${_DAILY_PENDING_SYNC_DOWN:-0}" -eq 1 ]; then
      echo "${API_CALL_COUNT:-0}" > "$_DAILY_COUNT_FILE"
      _DAILY_PENDING_SYNC_DOWN=0
      return
    fi

    # Step 2: check if upcoming command assigns API_CALL_COUNT
    if [[ "${BASH_COMMAND:-}" =~ (^|[[:space:];])API_CALL_COUNT= ]]; then
      # The assignment will run after this trap; schedule a sync-down
      _DAILY_PENDING_SYNC_DOWN=1
      return
    fi

    # Step 3: otherwise sync var up from file (capture subshell increments)
    API_CALL_COUNT=$(cat "$_DAILY_COUNT_FILE")
    export API_CALL_COUNT
  fi
}

trap '_daily_debug_trap' DEBUG

retry_with_backoff() {
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
export -f _daily_debug_trap
