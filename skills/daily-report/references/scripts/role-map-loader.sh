#!/usr/bin/env bash
# YAML role-map parser: yq → python3 yaml fallback. Bash regex parsing not allowed.

load_role_map() {
  local file=$1
  if [ ! -f "$file" ]; then
    echo "⚠ role map missing: $file" >&2
    echo '{"roles":{"pm":[],"dev":[],"qa":[]},"names":{}}'
    return 0
  fi

  local json
  if command -v yq >/dev/null 2>&1; then
    json=$(yq -o=json '.' "$file" 2>&1)
    if [ $? -ne 0 ]; then
      echo "❌ yq parse failed: $json" >&2
      return 1
    fi
  elif command -v python3 >/dev/null 2>&1; then
    json=$(ROLE_FILE_PATH="$file" python3 -c "
import yaml, json, os, sys
try:
    print(json.dumps(yaml.safe_load(open(os.environ['ROLE_FILE_PATH']))))
except Exception as e:
    print(f'PARSE_ERROR: {e}', file=sys.stderr)
    sys.exit(1)
" 2>&1)
    if [ $? -ne 0 ]; then
      echo "❌ python yaml parse failed: $json" >&2
      return 1
    fi
  else
    echo "❌ neither yq nor python3 available; bash YAML parse not allowed" >&2
    return 1
  fi
  echo "$json"
}

get_role_for() {
  local json=$1; local account=$2
  local role
  role=$(echo "$json" | jq -r --arg a "$account" '
    .roles // {} | to_entries
    | map(select(.value | index($a)))
    | (.[0].key // "unknown")
  ')
  echo "$role"
}

get_name_for() {
  local json=$1; local account=$2
  echo "$json" | jq -r --arg a "$account" '.names[$a] // ""'
}

export -f load_role_map get_role_for get_name_for
