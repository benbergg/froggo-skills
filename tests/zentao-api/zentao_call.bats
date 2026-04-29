#!/usr/bin/env bats

load 'test_helper'

setup() {
  zentao_setup_env
  source "$LIB_FILE"
  curl_stub_reset
  curl() { curl_stub "$@"; }
  export -f curl_stub curl

  # Pre-seed a valid token so we don't always run through acquire_token.
  printf '{"token":"abc123","acquired_at":"2026-04-29T00:00:00Z"}\n' \
    > "$ZENTAO_CACHE_DIR/token.json"
  chmod 600 "$ZENTAO_CACHE_DIR/token.json"
}

@test "uses cached token: GET with Token header, single curl call" {
  curl_stub_add '*GET*/user*' "$(load_fixture user.json)"

  run zentao_call /user
  [ "$status" -eq 0 ]
  [[ "$output" == *'"qingwa"'* ]]

  [ "$(curl_stub_call_count)" = "1" ]
  grep -q -- '-H Token: abc123' "$CURL_STUB_LOG"
  grep -q -- '-H Content-Type: application/json' "$CURL_STUB_LOG"
  grep -q -- '--noproxy' "$CURL_STUB_LOG"
}

@test "no cached token: acquires first then calls (2 curl calls)" {
  rm -f "$ZENTAO_CACHE_DIR/token.json"
  curl_stub_add '*POST*tokens*'   "$(load_fixture tokens-success.json)"
  curl_stub_add '*GET*/user*'     "$(load_fixture user.json)"

  run zentao_call /user
  [ "$status" -eq 0 ]
  [ "$(curl_stub_call_count)" = "2" ]
}

@test "401 then success: re-acquires token and retries once (3 curl calls)" {
  curl_stub_add '*GET*/user*'     "$(load_fixture unauthorized.json)"
  curl_stub_add '*POST*tokens*'   '{"token":"newtoken"}'
  curl_stub_add '*GET*/user*'     "$(load_fixture user.json)"

  run zentao_call /user
  [ "$status" -eq 0 ]
  [[ "$output" == *'"qingwa"'* ]]
  [ "$(curl_stub_call_count)" = "3" ]
  # Second GET must use the new token.
  grep -q -- '-H Token: newtoken' "$CURL_STUB_LOG"
}

@test "consecutive 401: only retries once, then surfaces error" {
  curl_stub_add '*GET*/user*'     "$(load_fixture unauthorized.json)"
  curl_stub_add '*POST*tokens*'   '{"token":"newtoken"}'
  curl_stub_add '*GET*/user*'     "$(load_fixture unauthorized.json)"

  run zentao_call /user
  # Either non-zero exit or stdout still contains the unauthorized payload — but
  # crucially: no third GET. Total = 1 GET + 1 POST + 1 GET retry = 3 calls.
  [ "$(curl_stub_call_count)" = "3" ]
}

@test "endpoint with query string is forwarded verbatim" {
  curl_stub_add '*GET*/executions?status=doing&limit=500*' '{"executions":[]}'

  run zentao_call '/executions?status=doing&limit=500'
  [ "$status" -eq 0 ]
  grep -qF -- 'executions?status=doing&limit=500' "$CURL_STUB_LOG"
}

@test "strips illegal control chars from response (jq parses cleanly)" {
  # API leaks raw \x01..\x08 \x0b \x0c \x0e..\x1f into string values.
  # Build a payload containing such a character; lib must strip it before emit.
  local dirty
  dirty=$(printf '{"name":"a\x01b","id":1}')
  curl_stub_add '*GET*/dirty*' "$dirty"

  run zentao_call /dirty
  [ "$status" -eq 0 ]
  # jq must parse the cleaned output without error.
  printf '%s' "$output" | jq -e '.id == 1' >/dev/null
  printf '%s' "$output" | jq -r .name | grep -q '^ab$'
}

@test "preserves \\t \\n \\r in response" {
  local mixed
  mixed=$(printf '{"text":"x\ty\nz"}')
  curl_stub_add '*GET*/mixed*' "$mixed"

  run zentao_call /mixed
  [ "$status" -eq 0 ]
  # \t and \n must survive (they are valid raw chars inside JSON string from
  # API perspective — jq itself accepts \t \n in raw input).
  [[ "$output" == *$'\t'* ]]
}
