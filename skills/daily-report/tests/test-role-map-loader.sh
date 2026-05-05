#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/role-map-loader.sh"

test_start "test-role-map-loader"

# 1. Valid file → JSON output
output=$(load_role_map "$DIR/fixtures/role-map-valid.yaml")
assert_contains "$output" '"pm"' "json contains pm"
assert_contains "$output" '"qingwa"' "json contains qingwa"

# 2. Missing file → fallback empty roles JSON, exit 0, warn
output=$(load_role_map "/nonexistent.yaml" 2>&1)
rc=$?
assert_eq "$rc" "0" "missing file does not abort"
assert_contains "$output" "missing" "warn message"

# 3. Malformed file → exit 1 with error
output=$(load_role_map "$DIR/fixtures/role-map-malformed.yaml" 2>&1)
rc=$?
assert_eq "$rc" "1" "malformed yaml aborts"

# 4. Lookup helpers
ROLE_JSON=$(load_role_map "$DIR/fixtures/role-map-valid.yaml")
assert_eq "$(get_role_for "$ROLE_JSON" qingwa)" "dev" "qingwa is dev"
assert_eq "$(get_role_for "$ROLE_JSON" zhao)" "qa" "zhao is qa"
assert_eq "$(get_role_for "$ROLE_JSON" account_x)" "unknown" "unknown fallback"
assert_eq "$(get_name_for "$ROLE_JSON" qingwa)" "青蛙" "name 青蛙"
assert_eq "$(get_name_for "$ROLE_JSON" account_x)" "" "no name for unknown"

test_end
