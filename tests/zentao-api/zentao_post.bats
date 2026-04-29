#!/usr/bin/env bats

load 'test_helper'

setup() {
  zentao_setup_env
  source "$LIB_FILE"
  curl_stub_reset
  curl() { curl_stub "$@"; }
  export -f curl_stub curl

  printf '{"token":"abc123","acquired_at":"2026-04-29T00:00:00Z"}\n' \
    > "$ZENTAO_CACHE_DIR/token.json"
  chmod 600 "$ZENTAO_CACHE_DIR/token.json"
}

@test "POST: sends JSON body with Token header" {
  curl_stub_add '*POST*/foo*' '{"id":42}'

  run zentao_post /foo '{"name":"x"}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"id":42'* ]]

  grep -q -- '-X POST' "$CURL_STUB_LOG"
  grep -q -- '-H Token: abc123' "$CURL_STUB_LOG"
  grep -q -- '-H Content-Type: application/json' "$CURL_STUB_LOG"
  grep -q -- '--noproxy' "$CURL_STUB_LOG"
  grep -qF -- '{"name":"x"}' "$CURL_STUB_LOG"
}

@test "PUT: sends JSON body with Token header" {
  curl_stub_add '*PUT*/foo/1*' '{"id":1,"updated":true}'

  run zentao_put /foo/1 '{"parent":99}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"updated":true'* ]]
  grep -q -- '-X PUT' "$CURL_STUB_LOG"
  grep -qF -- '{"parent":99}' "$CURL_STUB_LOG"
}

@test "POST 401: refreshes token and retries once" {
  curl_stub_add '*POST*/foo*'   '{"error":"Unauthorized"}'
  curl_stub_add '*POST*tokens*' '{"token":"newtok"}'
  curl_stub_add '*POST*/foo*'   '{"id":99}'

  run zentao_post /foo '{}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"id":99'* ]]
  [ "$(curl_stub_call_count)" = "3" ]
  grep -q -- '-H Token: newtok' "$CURL_STUB_LOG"
}

@test "POST consecutive 401: only retries once" {
  curl_stub_add '*POST*/foo*'   '{"error":"Unauthorized"}'
  curl_stub_add '*POST*tokens*' '{"token":"newtok"}'
  curl_stub_add '*POST*/foo*'   '{"error":"Unauthorized"}'

  run zentao_post /foo '{}'
  [ "$(curl_stub_call_count)" = "3" ]
}

@test "POST: strips illegal control chars from response" {
  local dirty=$(printf '{"name":"a\x01b","id":7}')
  curl_stub_add '*POST*/dirty*' "$dirty"

  run zentao_post /dirty '{}'
  [ "$status" -eq 0 ]
  printf '%s' "$output" | jq -e '.id == 7' >/dev/null
}

@test "POST: missing env vars aborts" {
  unset ZENTAO_BASE_URL
  run zentao_post /foo '{}'
  [ "$status" -ne 0 ]
}

@test "lib does NOT define any DELETE helper (safety guard rail)" {
  ! declare -F zentao_delete >/dev/null
  ! declare -F zentao_remove >/dev/null
  # Search source for the literal string -X DELETE just to be sure.
  ! grep -q -- '-X DELETE' "$LIB_FILE"
}
