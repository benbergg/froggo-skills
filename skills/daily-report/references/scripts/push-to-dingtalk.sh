#!/usr/bin/env bash
# Push daily-report summary + share URL to DingTalk group via robot webhook.
#
# Usage:
#   push-to-dingtalk.sh <daily.md> <share_url>
#
# Env:
#   DINGTALK_WEBHOOK    full webhook URL incl. access_token (required)
#   DINGTALK_SECRET     optional; if set, request will be HMAC-SHA256 signed
#   DINGTALK_KEYWORD    optional keyword required by the bot's security setting
#                       (will be appended to title to satisfy keyword match)
#
# Output:
#   DINGTALK_OK on success; non-zero exit on failure.

set -euo pipefail

DAILY_MD="${1:?usage: push-to-dingtalk.sh <daily.md> <share_url>}"
SHARE_URL="${2:?usage: push-to-dingtalk.sh <daily.md> <share_url>}"
WEBHOOK="${DINGTALK_WEBHOOK:?DINGTALK_WEBHOOK env not set}"
SECRET="${DINGTALK_SECRET:-}"
KEYWORD="${DINGTALK_KEYWORD:-}"

if [ ! -f "$DAILY_MD" ]; then
  echo "FATAL: daily file not found: $DAILY_MD" >&2
  exit 1
fi

TITLE=$(grep -m1 "^# " "$DAILY_MD" | sed 's/^# *//')
[ -z "$TITLE" ] && TITLE="产研日报"
[ -n "$KEYWORD" ] && TITLE="${TITLE} · ${KEYWORD}"

OVERVIEW=$(awk '/^## 概览/{flag=1; next} flag && /^---[[:space:]]*$/{flag=0} flag' "$DAILY_MD")
[ -z "$OVERVIEW" ] && OVERVIEW="(无概览段)"

TEXT=$(printf "## %s\n\n%s\n" "$TITLE" "$OVERVIEW")

FINAL_URL="$WEBHOOK"
if [ -n "$SECRET" ]; then
  TS=$(date +%s%3N)
  STR_TO_SIGN=$(printf '%s\n%s' "$TS" "$SECRET")
  SIGN=$(printf '%s' "$STR_TO_SIGN" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64 | jq -sRr @uri)
  FINAL_URL="${WEBHOOK}&timestamp=${TS}&sign=${SIGN}"
fi

PAYLOAD=$(jq -n \
  --arg title "$TITLE" \
  --arg text "$TEXT" \
  --arg url "$SHARE_URL" \
  '{
    msgtype: "actionCard",
    actionCard: {
      title: $title,
      text: $text,
      btnOrientation: "0",
      singleTitle: "查看完整日报",
      singleURL: $url
    }
  }')

RESP=$(curl -sS -H "Content-Type: application/json" "$FINAL_URL" -d "$PAYLOAD")
ERR=$(echo "$RESP" | jq -r '.errcode // 99')
if [ "$ERR" = "0" ]; then
  echo "DINGTALK_OK"
else
  echo "DINGTALK_FAIL:$RESP" >&2
  exit 2
fi
