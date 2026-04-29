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

# helper: assert <method> + <url> appeared in curl call log
assert_call() {
  local method="$1" url_substr="$2"
  grep -- "-X $method" "$CURL_STUB_LOG" | grep -qF -- "$url_substr"
}

# ---- update_task : PUT /tasks/{id} ----

@test "update_task: PUT to /tasks/{id} with body" {
  curl_stub_add '*PUT*/tasks/100*' '{"id":100,"name":"renamed"}'
  run zentao_update_task 100 '{"name":"renamed"}'
  [ "$status" -eq 0 ]
  assert_call PUT '/tasks/100'
  grep -qF -- '"name":"renamed"' "$CURL_STUB_LOG"
}

@test "update_task: missing id aborts" {
  run zentao_update_task '' '{}'
  [ "$status" -ne 0 ]
}

@test "update_task: non-numeric id aborts" {
  run zentao_update_task 'abc' '{}'
  [ "$status" -ne 0 ]
}

# ---- start_task : POST /tasks/{id}/start ----

@test "start_task: POST to /tasks/{id}/start" {
  curl_stub_add '*POST*/tasks/200/start*' '{"id":200,"status":"doing"}'
  run zentao_start_task 200 '{"left":4}'
  [ "$status" -eq 0 ]
  assert_call POST '/tasks/200/start'
  grep -qF -- '"left":4' "$CURL_STUB_LOG"
}

@test "start_task: empty body uses default {}" {
  curl_stub_add '*POST*/tasks/201/start*' '{"id":201}'
  run zentao_start_task 201
  [ "$status" -eq 0 ]
  assert_call POST '/tasks/201/start'
}

# ---- pause_task : POST /tasks/{id}/pause ----

@test "pause_task: POST to /tasks/{id}/pause" {
  curl_stub_add '*POST*/tasks/300/pause*' '{"id":300,"status":"pause"}'
  run zentao_pause_task 300 '{"comment":"stuck on db schema"}'
  [ "$status" -eq 0 ]
  assert_call POST '/tasks/300/pause'
}

# ---- resume_task : POST /tasks/{id}/restart ----

@test "resume_task: POST to /tasks/{id}/restart (NOT /resume)" {
  curl_stub_add '*POST*/tasks/400/restart*' '{"id":400,"status":"doing"}'
  run zentao_resume_task 400 '{"left":2}'
  [ "$status" -eq 0 ]
  assert_call POST '/tasks/400/restart'
  # negative: must NOT hit /resume which is a common mis-spelling
  ! grep -qF -- '/tasks/400/resume' "$CURL_STUB_LOG"
}

# ---- finish_task : POST /tasks/{id}/finish ----

@test "finish_task: POST to /tasks/{id}/finish" {
  curl_stub_add '*POST*/tasks/500/finish*' '{"id":500,"status":"done"}'
  run zentao_finish_task 500 '{"currentConsumed":3,"finishedDate":"2026-04-29 18:00:00"}'
  [ "$status" -eq 0 ]
  assert_call POST '/tasks/500/finish'
}

# ---- close_task : POST /tasks/{id}/close ----

@test "close_task: POST to /tasks/{id}/close" {
  curl_stub_add '*POST*/tasks/600/close*' '{"id":600,"status":"closed"}'
  run zentao_close_task 600 '{"comment":"obsolete"}'
  [ "$status" -eq 0 ]
  assert_call POST '/tasks/600/close'
}

# ---- create_task_log : POST /tasks/{id}/estimate ----

@test "create_task_log: POST to /tasks/{id}/estimate" {
  curl_stub_add '*POST*/tasks/700/estimate*' '{"id":700,"consumed":5}'
  run zentao_create_task_log 700 \
    '{"date":["2026-04-29"],"work":["wrote unit tests"],"consumed":[2],"left":[3]}'
  [ "$status" -eq 0 ]
  assert_call POST '/tasks/700/estimate'
  grep -qF -- '"date":["2026-04-29"]' "$CURL_STUB_LOG"
}

@test "create_task_log: invalid JSON body aborts" {
  run zentao_create_task_log 700 'not-json'
  [ "$status" -ne 0 ]
}

# ---- get_task_logs : GET /tasks/{id}/estimate ----

@test "get_task_logs: GET /tasks/{id}/estimate" {
  curl_stub_add '*GET*/tasks/800/estimate*' '{"effort":[]}'
  run zentao_get_task_logs 800
  [ "$status" -eq 0 ]
  [[ "$output" == *'"effort"'* ]]
  assert_call GET '/tasks/800/estimate'
}

# ---- safety guard rail: still no DELETE function ----

@test "no DELETE helper exists for task lifecycle" {
  ! declare -F zentao_delete_task >/dev/null
  ! declare -F zentao_remove_task >/dev/null
}
