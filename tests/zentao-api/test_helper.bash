#!/usr/bin/env bash
# Test helper for zentao-api bats suite.
# Provides isolated env, curl stub framework, and fixture loading.

# Locate repo root (two levels up from this file's directory).
TEST_HELPER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_HELPER_DIR/../.." && pwd)"
LIB_FILE="$REPO_ROOT/skills/zentao-api/lib/zentao.sh"
FIXTURES_DIR="$TEST_HELPER_DIR/fixtures"

# Per-test isolated cache dir; tests may override before sourcing lib.
zentao_setup_env() {
  export ZENTAO_BASE_URL="https://zt.example/api.php/v1"
  export ZENTAO_ACCOUNT="qingwa"
  export ZENTAO_PASSWORD="secret"
  export ZENTAO_ME="qingwa"
  export ZENTAO_CACHE_DIR="$BATS_TEST_TMPDIR/zentao-cache"
  mkdir -p "$ZENTAO_CACHE_DIR"
  chmod 700 "$ZENTAO_CACHE_DIR"
}

load_fixture() {
  cat "$FIXTURES_DIR/$1"
}

# Curl stub framework.
# Usage in a test:
#   curl_stub_reset
#   curl_stub_add 'POST*tokens' "$(load_fixture tokens-success.json)"
#   curl() { curl_stub "$@"; }
curl_stub_reset() {
  CURL_STUB_FILE="$BATS_TEST_TMPDIR/curl-stub.list"
  CURL_STUB_LOG="$BATS_TEST_TMPDIR/curl-stub.log"
  : > "$CURL_STUB_FILE"
  : > "$CURL_STUB_LOG"
}

# curl_stub_add <pattern> <body>
# Pattern matched against the curl arg list joined by spaces using bash [[ == ]].
# Patterns are tried in FIFO order; first match wins; entry is consumed unless prefixed with 'sticky:'.
curl_stub_add() {
  local pattern="$1"
  local body="$2"
  printf '%s\n' "${pattern}|||${body}" >> "$CURL_STUB_FILE"
}

curl_stub() {
  local args="$*"
  printf 'CALL: %s\n' "$args" >> "$CURL_STUB_LOG"
  local tmp="$BATS_TEST_TMPDIR/curl-stub.next"
  : > "$tmp"
  local matched=0
  while IFS= read -r line; do
    if (( matched == 0 )); then
      local pattern="${line%%|||*}"
      local body="${line#*|||}"
      local sticky=0
      if [[ "$pattern" == sticky:* ]]; then
        sticky=1
        pattern="${pattern#sticky:}"
      fi
      # shellcheck disable=SC2053
      if [[ "$args" == $pattern ]]; then
        printf '%s' "$body"
        matched=1
        if (( sticky == 1 )); then
          printf '%s\n' "$line" >> "$tmp"
        fi
        continue
      fi
    fi
    printf '%s\n' "$line" >> "$tmp"
  done < "$CURL_STUB_FILE"
  mv "$tmp" "$CURL_STUB_FILE"
  if (( matched == 0 )); then
    printf 'curl-stub: no pattern matched: %s\n' "$args" >&2
    return 99
  fi
}

curl_stub_call_count() {
  wc -l < "$CURL_STUB_LOG" | tr -d ' '
}
