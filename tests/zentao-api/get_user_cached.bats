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

# stat helper that works on both BSD and GNU.
file_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"
}
file_perm() {
  stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"
}

@test "miss: fetches /user, writes cache with mode 600" {
  curl_stub_add '*GET*/user*' "$(load_fixture user.json)"

  run get_user_cached
  [ "$status" -eq 0 ]
  [[ "$output" == *'"qingwa"'* ]]

  local f="$ZENTAO_CACHE_DIR/user.json"
  [ -f "$f" ]
  [ "$(file_perm "$f")" = "600" ]
  [ "$(jq -r .profile.account "$f")" = "qingwa" ]
}

@test "hit (fresh cache): does NOT call curl" {
  printf '%s' "$(load_fixture user.json)" > "$ZENTAO_CACHE_DIR/user.json"
  chmod 600 "$ZENTAO_CACHE_DIR/user.json"
  # touch to "now" — well within 24h TTL.

  run get_user_cached
  [ "$status" -eq 0 ]
  [[ "$output" == *'"qingwa"'* ]]
  [ "$(curl_stub_call_count)" = "0" ]
}

@test "expired (>24h): refetches" {
  printf '{"profile":{"account":"stale"}}' > "$ZENTAO_CACHE_DIR/user.json"
  chmod 600 "$ZENTAO_CACHE_DIR/user.json"
  # Backdate to 25h ago.
  local old=$(( $(date +%s) - 90000 ))
  touch -t "$(date -r "$old" +%Y%m%d%H%M.%S 2>/dev/null || date -d "@$old" +%Y%m%d%H%M.%S)" \
    "$ZENTAO_CACHE_DIR/user.json"

  curl_stub_add '*GET*/user*' "$(load_fixture user.json)"

  run get_user_cached
  [ "$status" -eq 0 ]
  [[ "$output" == *'"qingwa"'* ]]
  [ "$(curl_stub_call_count)" = "1" ]
  [ "$(jq -r .profile.account "$ZENTAO_CACHE_DIR/user.json")" = "qingwa" ]
}
