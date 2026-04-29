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

@test "single-page (total < limit): one curl call, body emitted once" {
  curl_stub_add '*page=1*' '{"page":1,"total":3,"items":[{"id":1},{"id":2},{"id":3}]}'

  run paginate /executions/100/tasks
  [ "$status" -eq 0 ]
  [ "$(curl_stub_call_count)" = "1" ]
  # Output should be a single JSON document (we just emit raw bodies).
  [[ "$output" == *'"total":3'* ]]
}

@test "multi-page: stops once cumulative >= total" {
  # total=1200, limit=500 → pages 1,2,3 (cumulative 500,1000,1500 ≥ 1200)
  curl_stub_add '*page=1*' '{"page":1,"total":1200,"items":[]}'
  curl_stub_add '*page=2*' '{"page":2,"total":1200,"items":[]}'
  curl_stub_add '*page=3*' '{"page":3,"total":1200,"items":[]}'

  run paginate /products/131/bugs
  [ "$status" -eq 0 ]
  [ "$(curl_stub_call_count)" = "3" ]
}

@test "empty response (total=0): one call, then stops" {
  curl_stub_add '*page=1*' '{"page":1,"total":0,"items":[]}'

  run paginate /executions/999/tasks
  [ "$status" -eq 0 ]
  [ "$(curl_stub_call_count)" = "1" ]
}

@test "safety valve: bails after page 20 even if total never satisfied" {
  # All pages return same lying total to simulate runaway pagination.
  for i in $(seq 1 25); do
    curl_stub_add "*page=$i*" '{"page":'"$i"',"total":99999999,"items":[]}'
  done

  run paginate /tasks
  [ "$status" -eq 0 ]
  # Should stop at page 20, never call page 21+.
  local n; n=$(curl_stub_call_count)
  [ "$n" = "20" ]
}

@test "passes endpoint and limit=500 in query" {
  curl_stub_add '*page=1*' '{"page":1,"total":0,"items":[]}'
  run paginate /executions/77/tasks
  [ "$status" -eq 0 ]
  grep -qF -- '/executions/77/tasks?limit=500&page=1' "$CURL_STUB_LOG"
}
