#!/usr/bin/env bats

load 'test_helper'

setup() {
  zentao_setup_env
  source "$LIB_FILE"
  curl_stub_reset
  # Override curl to use the stub framework.
  curl() { curl_stub "$@"; }
  export -f curl_stub curl
}

@test "happy path: writes token file with mode 600 and prints token" {
  curl_stub_add '*POST*tokens*' "$(load_fixture tokens-success.json)"

  run acquire_token
  [ "$status" -eq 0 ]
  [ "$output" = "19f62f1a50e94cd173e5560925f71873" ]

  local cache token_file
  cache=$(zentao_cache_dir)
  token_file="$cache/token.json"
  [ -f "$token_file" ]
  [ "$(jq -r .token "$token_file")" = "19f62f1a50e94cd173e5560925f71873" ]
  [ -n "$(jq -r .acquired_at "$token_file")" ]

  # Permission must be 600 (BSD stat -f %Lp / GNU stat -c %a both produce '600').
  local perm
  perm=$(stat -f %Lp "$token_file" 2>/dev/null || stat -c %a "$token_file")
  [ "$perm" = "600" ]
}

@test "request body uses 'account' field, not 'username'" {
  curl_stub_add '*POST*tokens*' "$(load_fixture tokens-success.json)"
  run acquire_token
  [ "$status" -eq 0 ]
  grep -q '"account":"qingwa"' "$CURL_STUB_LOG"
  ! grep -q '"username":' "$CURL_STUB_LOG"
}

@test "request includes --noproxy and --max-time" {
  curl_stub_add '*POST*tokens*' "$(load_fixture tokens-success.json)"
  run acquire_token
  [ "$status" -eq 0 ]
  grep -q -- '--noproxy' "$CURL_STUB_LOG"
  grep -q -- '--max-time 20' "$CURL_STUB_LOG"
}

@test "missing ZENTAO_PASSWORD aborts with non-zero exit" {
  unset ZENTAO_PASSWORD
  run acquire_token
  [ "$status" -ne 0 ]
  [[ "$output" == *"ZENTAO_PASSWORD"* ]] || [[ "$stderr" == *"ZENTAO_PASSWORD"* ]] || [[ "$output$stderr" == *"ZENTAO_PASSWORD"* ]]
}

@test "missing ZENTAO_ACCOUNT aborts with non-zero exit" {
  unset ZENTAO_ACCOUNT
  run acquire_token
  [ "$status" -ne 0 ]
}

@test "missing ZENTAO_BASE_URL aborts with non-zero exit" {
  unset ZENTAO_BASE_URL
  run acquire_token
  [ "$status" -ne 0 ]
}

@test "API error response (no token field) aborts with non-zero exit" {
  curl_stub_add '*POST*tokens*' "$(load_fixture tokens-fail.json)"
  run acquire_token
  [ "$status" -ne 0 ]
}

@test "empty response aborts with non-zero exit" {
  curl_stub_add '*POST*tokens*' ""
  run acquire_token
  [ "$status" -ne 0 ]
}
