#!/usr/bin/env bash
# Mock zt-functions for e2e testing.
# Returns fixture JSON based on endpoint path. No network, no credentials.
#
# Usage:
#   export ZT_FUNCTIONS_OVERRIDE=path/to/this/file
#   bash run.sh manual

# Resolve fixtures directory once.
_E2E_FIXTURES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../fixtures/e2e" && pwd)"

# Mock S1: no-op success
zt_init() {
  return 0
}

# Mock S2: no-op success (no real token needed)
zt_acquire_token() {
  echo "mock-token-e2e"
  return 0
}

# Mock S3: route GET endpoint to a fixture file.
# Map paths (with placeholders) to fixture filenames.
zt_get() {
  local ep="$1"
  local file=""
  case "$ep" in
    /user)                                file="user.json" ;;
    /products/95)                         file="product-95.json" ;;
    /products/95/projects)                file="product-95-projects.json" ;;
    /projects/3001/executions)            file="project-3001-executions.json" ;;
    *)
      # Strip query string for matching
      local base="${ep%%\?*}"
      case "$base" in
        /products/95/stories)             file="product-95-stories.json" ;;
        /products/95/bugs)                file="product-95-bugs.json" ;;
        /executions/4001/tasks)           file="execution-4001-tasks.json" ;;
        *)
          echo "MOCK: no fixture for endpoint: $ep" >&2
          echo "{}"
          return 1
          ;;
      esac
      ;;
  esac
  cat "$_E2E_FIXTURES_DIR/$file"
}

# Mock S5: same as zt_get (single-page fixtures sufficient for tests).
zt_paginate() {
  zt_get "$1"
}

# Mock S4: write operations are not exercised in daily-report (read-only skill).
zt_write() {
  echo "MOCK: zt_write not implemented (daily-report is read-only)" >&2
  return 1
}

# Mock S6: optional helper, no-op for daily-report tests.
zt_week_range() {
  return 0
}

export -f zt_init zt_acquire_token zt_get zt_paginate zt_write zt_week_range
