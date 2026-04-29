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

# ---------- zentao_create_task ----------

@test "create_task: POSTs to /executions/{eid}/tasks with given body" {
  curl_stub_add '*POST*/executions/3292/tasks*' '{"id":1001,"name":"x","execution":3292}'

  run zentao_create_task 3292 '{"name":"x","estStarted":"2026-04-29","deadline":"2026-04-30"}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"id":1001'* ]]

  grep -q -- '-X POST' "$CURL_STUB_LOG"
  grep -qF -- '/executions/3292/tasks' "$CURL_STUB_LOG"
  grep -qF -- '"name":"x"' "$CURL_STUB_LOG"
}

@test "create_task: missing execution arg aborts" {
  run zentao_create_task '' '{"name":"x"}'
  [ "$status" -ne 0 ]
}

@test "create_task: empty body aborts" {
  run zentao_create_task 3292 ''
  [ "$status" -ne 0 ]
}

@test "create_task: malformed JSON body aborts" {
  run zentao_create_task 3292 'not-json'
  [ "$status" -ne 0 ]
}

# ---------- zentao_create_subtask ----------

@test "create_subtask: two-step flow (POST then PUT parent)" {
  curl_stub_add '*POST*/executions/3292/tasks*' '{"id":2002,"name":"sub","execution":3292,"parent":0}'
  curl_stub_add '*PUT*/tasks/2002*'              '{"id":2002,"parent":99}'

  run zentao_create_subtask 3292 99 '{"name":"sub","estStarted":"2026-04-29","deadline":"2026-04-30"}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"parent":99'* ]]

  [ "$(curl_stub_call_count)" = "2" ]
  grep -q -- '-X POST' "$CURL_STUB_LOG"
  grep -q -- '-X PUT'  "$CURL_STUB_LOG"
  grep -qF -- '/executions/3292/tasks' "$CURL_STUB_LOG"
  grep -qF -- '/tasks/2002' "$CURL_STUB_LOG"
  # PUT body must include parent=99
  grep -qF -- '"parent":99' "$CURL_STUB_LOG"
}

@test "create_subtask: parent field stripped from POST body (API ignores it)" {
  curl_stub_add '*POST*/executions/3292/tasks*' '{"id":2003,"parent":0}'
  curl_stub_add '*PUT*/tasks/2003*'              '{"id":2003,"parent":42}'

  run zentao_create_subtask 3292 42 \
    '{"name":"sub","parent":99999,"estStarted":"2026-04-29","deadline":"2026-04-30"}'
  [ "$status" -eq 0 ]

  # Inspect the POST call line specifically. The forged 99999 must NOT survive
  # into the POST body (we strip it). The 42 must appear only in the PUT call.
  local post_line
  post_line=$(grep -- '-X POST' "$CURL_STUB_LOG")
  [[ "$post_line" != *'99999'* ]]
  ! [[ "$post_line" == *'"parent":42'* ]]

  local put_line
  put_line=$(grep -- '-X PUT' "$CURL_STUB_LOG")
  [[ "$put_line" == *'"parent":42'* ]]
}

@test "create_subtask: missing parent_id aborts before any HTTP" {
  run zentao_create_subtask 3292 '' '{"name":"sub"}'
  [ "$status" -ne 0 ]
  [ "$(curl_stub_call_count)" = "0" ]
}

@test "create_subtask: parent_id must be numeric" {
  run zentao_create_subtask 3292 'not-a-number' '{"name":"sub"}'
  [ "$status" -ne 0 ]
}

@test "create_subtask: aborts if POST step fails (no PUT issued)" {
  curl_stub_add '*POST*/executions/3292/tasks*' '{"error":"bad request"}'

  run zentao_create_subtask 3292 99 \
    '{"name":"sub","estStarted":"2026-04-29","deadline":"2026-04-30"}'
  [ "$status" -ne 0 ]
  # Only POST should have been issued, no PUT.
  [ "$(curl_stub_call_count)" = "1" ]
  ! grep -q -- '-X PUT' "$CURL_STUB_LOG"
}
