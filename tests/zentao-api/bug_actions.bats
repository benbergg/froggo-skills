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

assert_call() {
  local method="$1" url_substr="$2"
  grep -- "-X $method" "$CURL_STUB_LOG" | grep -qF -- "$url_substr"
}

# ---- create_bug : POST /products/{pid}/bugs ----

@test "create_bug: POST to /products/{pid}/bugs" {
  curl_stub_add '*POST*/products/131/bugs*' '{"id":9000,"title":"x"}'
  run zentao_create_bug 131 \
    '{"title":"login fails on 401","severity":3,"pri":2,"type":"codeerror"}'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"id":9000'* ]]
  assert_call POST '/products/131/bugs'
}

@test "create_bug: missing product id aborts" {
  run zentao_create_bug '' '{"title":"x"}'
  [ "$status" -ne 0 ]
}

@test "create_bug: empty body aborts (title etc. are required)" {
  run zentao_create_bug 131 ''
  [ "$status" -ne 0 ]
}

# ---- update_bug : PUT /bugs/{id} ----

@test "update_bug: PUT to /bugs/{id}" {
  curl_stub_add '*PUT*/bugs/52912*' '{"id":52912,"title":"renamed"}'
  run zentao_update_bug 52912 '{"title":"renamed"}'
  [ "$status" -eq 0 ]
  assert_call PUT '/bugs/52912'
}

# ---- confirm_bug : POST /bugs/{id}/confirm ----

@test "confirm_bug: POST to /bugs/{id}/confirm" {
  curl_stub_add '*POST*/bugs/52912/confirm*' '{"id":52912,"confirmed":1}'
  run zentao_confirm_bug 52912 '{"comment":"reproduced"}'
  [ "$status" -eq 0 ]
  assert_call POST '/bugs/52912/confirm'
}

# ---- close_bug : POST /bugs/{id}/close ----

@test "close_bug: POST to /bugs/{id}/close" {
  curl_stub_add '*POST*/bugs/52912/close*' '{"id":52912,"status":"closed"}'
  run zentao_close_bug 52912 '{"comment":"obsolete"}'
  [ "$status" -eq 0 ]
  assert_call POST '/bugs/52912/close'
}

# ---- activate_bug : POST /bugs/{id}/active (NOT /activate) ----

@test "activate_bug: POST to /bugs/{id}/active (NOT /activate)" {
  curl_stub_add '*POST*/bugs/52912/active*' '{"id":52912,"status":"active"}'
  run zentao_activate_bug 52912 '{"comment":"reopened"}'
  [ "$status" -eq 0 ]
  assert_call POST '/bugs/52912/active'
  ! grep -qF -- '/bugs/52912/activate' "$CURL_STUB_LOG"
}

# ---- resolve_bug : POST /bugs/{id}/resolve ----

@test "resolve_bug: POST to /bugs/{id}/resolve" {
  curl_stub_add '*POST*/bugs/52912/resolve*' '{"id":52912,"status":"resolved"}'
  run zentao_resolve_bug 52912 '{"resolution":"fixed","comment":"PR #42"}'
  [ "$status" -eq 0 ]
  assert_call POST '/bugs/52912/resolve'
  grep -qF -- '"resolution":"fixed"' "$CURL_STUB_LOG"
}

@test "resolve_bug: missing body aborts (resolution required by API)" {
  run zentao_resolve_bug 52912 ''
  [ "$status" -ne 0 ]
}

# ---- safety guard rails ----

@test "no DELETE helper exists for bugs" {
  ! declare -F zentao_delete_bug >/dev/null
  ! declare -F zentao_remove_bug >/dev/null
  ! declare -F zentao_close_and_delete_bug >/dev/null
}

@test "lib source still contains zero '-X DELETE' occurrences" {
  ! grep -q -- '-X DELETE' "$LIB_FILE"
}
