#!/usr/bin/env bash
# D3+D4: bug collection with status buckets and today filter (design §4.4-§4.5).

# Normalize people fields and select only in-scope bugs.
# Person fields (openedBy/assignedTo/resolvedBy/closedBy) may be string or
# {id, account, realname, avatar} object. Output is a display string.
#
# In-scope bug definition (per user feedback):
#   - "当天完成的": today opened, resolved, or closed (any same-day event)
#   - "历史未完成的": status == "active" (still open, not yet resolved)
# Out-of-scope:
#   - Historical resolved (status=resolved with resolvedDate < today): already solved, awaiting close
#   - Historical closed (status=closed with closedDate < today): fully done
filter_in_scope_bugs() {
  local bugs=$1
  local today_start=$2
  echo "$bugs" | jq --arg t "$today_start" '
    ($t | .[0:10]) as $tdate |
    def normalize_person:
      if type == "object" then (.realname // .account // "") else (. // "") end;
    def is_today(field):
      (.[field] // null) as $d
      | $d != null and $d != "" and ($d | .[0:10]) >= $tdate;
    [.[]
     | .openedBy    |= normalize_person
     | .assignedTo  |= normalize_person
     | (if has("resolvedBy") then .resolvedBy |= normalize_person else . end)
     | (if has("closedBy")   then .closedBy   |= normalize_person else . end)
    ]
    | map(select(
        # active and confirmed: still pending bugs (历史未完成)
        .status == "active"
        or .status == "confirmed"
        # any same-day event: today opened/resolved/closed (当天完成)
        or is_today("openedDate")
        or is_today("resolvedDate")
        or is_today("closedDate")
        # postponed: closed bugs deferred — list endpoint quirk; only keep
        # if today-closed (otherwise historical noise)
      ))
  '
}

# classify_bugs: bucket a bug array by lifecycle status.
# Should be called on the in-scope subset (filter_in_scope_bugs result).
#
# Output buckets (priority — first match wins):
#   已关闭      - status == "closed"  (only today-closed survive filter)
#   已解决待验  - status == "resolved"
#   新增/未处理 - status == "active" AND confirmed == 0 (or "0")
#   处理中      - status == "active" AND confirmed != 0
classify_bugs() {
  local bugs=$1
  echo "$bugs" | jq '
    {
      "新增/未处理": map(select(.status == "active" and (.confirmed == 0 or .confirmed == "0"))),
      "处理中":     map(select(.status == "active" and (.confirmed != 0 and .confirmed != "0"))),
      "已解决待验": map(select(.status == "resolved")),
      "已关闭":     map(select(.status == "closed"))
    }
  '
}

# today_bugs: filter bugs changed today (opened, resolved, or closed on or after today_start).
#
# Input:
#   $1  bugs        - JSON array of bug objects
#   $2  today_start - ISO8601 UTC timestamp marking start of today window
#                     (e.g. "2026-05-05T00:00:00Z")
#
# Date prefix normalization (T4 lesson): real API may return dates as
# "2026-05-05", "2026-05-05 18:30:00", or "2026-05-05T00:00:00Z".
# Both sides are normalized to .[0:10] before comparison.
#
# Output: JSON object with keys: 新建, 解决, 关闭
today_bugs() {
  local bugs=$1
  local today_start=$2
  echo "$bugs" | jq --arg t "$today_start" '
    ($t | .[0:10]) as $tdate
    |
    {
      "新建": map(select(.openedDate   != null and .openedDate   != "" and (.openedDate   | .[0:10]) >= $tdate)),
      "解决": map(select(.resolvedDate != null and .resolvedDate != "" and (.resolvedDate | .[0:10]) >= $tdate)),
      "关闭": map(select(.closedDate   != null and .closedDate   != "" and (.closedDate   | .[0:10]) >= $tdate))
    }
  '
}

# collect_bugs_for_product: production wrapper — paginate then classify.
# Depends on retry_with_backoff and zt_paginate (sourced by run.sh in T11).
#
# Input:
#   $1  pid - product ID
collect_bugs_for_product() {
  local pid=$1
  local raw
  raw=$(retry_with_backoff zt_paginate "/products/$pid/bugs?status=all" 100)
  echo "$raw" | jq '.bugs // .'
}

export -f filter_in_scope_bugs classify_bugs today_bugs collect_bugs_for_product
