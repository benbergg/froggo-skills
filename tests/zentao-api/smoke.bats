#!/usr/bin/env bats

load 'test_helper'

@test "lib file exists and sources cleanly" {
  [ -f "$LIB_FILE" ]
  source "$LIB_FILE"
}

@test "zentao_cache_dir honours ZENTAO_CACHE_DIR override" {
  source "$LIB_FILE"
  export ZENTAO_CACHE_DIR="/tmp/zentao-test-xyz"
  run zentao_cache_dir
  [ "$status" -eq 0 ]
  [ "$output" = "/tmp/zentao-test-xyz" ]
}
