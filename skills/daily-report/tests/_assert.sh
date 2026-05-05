#!/usr/bin/env bash
# Simple test assertion library, sourced by individual test-*.sh files

set -u

_TEST_NAME=""
_PASS=0
_FAIL=0

assert_eq() {
  [ $# -ge 2 ] || { echo "  ❌ ${FUNCNAME[0]}: requires 2+ args, got $#" >&2; _FAIL=$((_FAIL + 1)); return 1; }
  local actual=$1; local expected=$2; local msg=${3:-}
  if [ "$actual" = "$expected" ]; then
    _PASS=$((_PASS + 1))
  else
    _FAIL=$((_FAIL + 1))
    echo "  ❌ ${msg:-assert_eq} — expected '$expected' got '$actual'" >&2
  fi
}

assert_ne() {
  [ $# -ge 2 ] || { echo "  ❌ ${FUNCNAME[0]}: requires 2+ args, got $#" >&2; _FAIL=$((_FAIL + 1)); return 1; }
  local actual=$1; local expected=$2; local msg=${3:-}
  if [ "$actual" != "$expected" ]; then
    _PASS=$((_PASS + 1))
  else
    _FAIL=$((_FAIL + 1))
    echo "  ❌ ${msg:-assert_ne} — value '$expected' should not equal actual" >&2
  fi
}

assert_contains() {
  [ $# -ge 2 ] || { echo "  ❌ ${FUNCNAME[0]}: requires 2+ args, got $#" >&2; _FAIL=$((_FAIL + 1)); return 1; }
  local haystack=$1; local needle=$2; local msg=${3:-}
  if echo "$haystack" | grep -qF "$needle"; then
    _PASS=$((_PASS + 1))
  else
    _FAIL=$((_FAIL + 1))
    echo "  ❌ ${msg:-assert_contains} — '$needle' not in: ${haystack:0:200}" >&2
  fi
}

assert_not_contains() {
  [ $# -ge 2 ] || { echo "  ❌ ${FUNCNAME[0]}: requires 2+ args, got $#" >&2; _FAIL=$((_FAIL + 1)); return 1; }
  local haystack=$1; local needle=$2; local msg=${3:-}
  if echo "$haystack" | grep -qF "$needle"; then
    _FAIL=$((_FAIL + 1))
    echo "  ❌ ${msg:-assert_not_contains} — '$needle' should not be in: ${haystack:0:200}" >&2
  else
    _PASS=$((_PASS + 1))
  fi
}

assert_exit() {
  [ $# -ge 2 ] || { echo "  ❌ ${FUNCNAME[0]}: requires 2+ args, got $#" >&2; _FAIL=$((_FAIL + 1)); return 1; }
  local actual=$1; local expected=$2; local msg=${3:-}
  if [ "$actual" -eq "$expected" ]; then
    _PASS=$((_PASS + 1))
  else
    _FAIL=$((_FAIL + 1))
    echo "  ❌ ${msg:-assert_exit} — expected exit $expected got $actual" >&2
  fi
}

test_start() {
  [ $# -ge 1 ] || { echo "❌ test_start: requires 1 arg (test name)" >&2; return 1; }
  _TEST_NAME=$1
  _PASS=0
  _FAIL=0
  echo "=== $_TEST_NAME ==="
}

test_end() {
  echo "  $_TEST_NAME: pass=$_PASS fail=$_FAIL"
  [ "$_FAIL" -eq 0 ]
}
