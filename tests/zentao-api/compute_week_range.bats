#!/usr/bin/env bats

load 'test_helper'

setup() {
  zentao_setup_env
  source "$LIB_FILE"
}

@test "computes Mon..NextMon..NextNextMon for a Wednesday" {
  NOW_OVERRIDE="2026-04-29T10:00:00Z" compute_week_range
  [ "$WK_START" = "2026-04-27T00:00:00Z" ]
  [ "$WK_END"   = "2026-05-04T00:00:00Z" ]
  [ "$NEXT_S"   = "2026-05-04T00:00:00Z" ]
  [ "$NEXT_E"   = "2026-05-11T00:00:00Z" ]
}

@test "Monday 00:00 belongs to that week (left edge)" {
  NOW_OVERRIDE="2026-04-27T00:00:00Z" compute_week_range
  [ "$WK_START" = "2026-04-27T00:00:00Z" ]
  [ "$WK_END"   = "2026-05-04T00:00:00Z" ]
}

@test "Sunday 23:59 belongs to that week (right edge)" {
  NOW_OVERRIDE="2026-05-03T23:59:59Z" compute_week_range
  [ "$WK_START" = "2026-04-27T00:00:00Z" ]
  [ "$WK_END"   = "2026-05-04T00:00:00Z" ]
}

@test "exports variables to environment" {
  NOW_OVERRIDE="2026-04-29T10:00:00Z" compute_week_range
  run env
  [[ "$output" == *"WK_START=2026-04-27T00:00:00Z"* ]]
  [[ "$output" == *"NEXT_E=2026-05-11T00:00:00Z"* ]]
}
