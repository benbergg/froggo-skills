#!/usr/bin/env bash
# D1+D2: story collection with four-state classification (design §4.2-§4.3).

# classify_stories: pure function mapping story array to four buckets.
#
# Input:
#   $1  stories  - JSON array of story objects
#   $2  today_start - ISO8601 UTC timestamp marking start of "today" window
#                     (e.g. "2026-05-05T00:00:00Z")
#
# Output: JSON object with keys: in_progress, today_done, unassigned, idle
#   today_done  - closedDate or finishedDate >= today_start
#   early_done  - already closed/released before today (excluded from output)
#   unassigned  - stage=wait AND assignedTo is empty/null
#   idle        - stage=wait AND assignedTo is non-empty
#   in_progress - all other active stories
classify_stories() {
  local stories=$1
  local today_start=$2

  echo "$stories" | jq --arg t "$today_start" '
    # Normalize today_start to date-only prefix for comparison with date fields
    ($t | .[0:10]) as $tdate |
    [.[] |
     if ((.closedDate != null and .closedDate != "" and (.closedDate | .[0:10]) >= $tdate) or
         (.finishedDate != null and .finishedDate != "" and (.finishedDate | .[0:10]) >= $tdate)) then
       . + {bucket: "today_done"}
     elif (.status == "closed" or .stage == "closed" or .stage == "released") then
       . + {bucket: "early_done"}
     elif (.stage == "wait") then
       if (.assignedTo == null or .assignedTo == "") then
         . + {bucket: "unassigned"}
       else
         . + {bucket: "idle"}
       end
     else
       . + {bucket: "in_progress"}
     end]
    | map(select(.bucket != "early_done"))
    | {
        in_progress: map(select(.bucket == "in_progress")),
        today_done:  map(select(.bucket == "today_done")),
        unassigned:  map(select(.bucket == "unassigned")),
        idle:        map(select(.bucket == "idle"))
      }
  '
}

# collect_stories_for_product: production wrapper — paginate then classify.
# Depends on retry_with_backoff and zt_paginate (sourced by run.sh in T11).
#
# Input:
#   $1  pid         - product ID
#   $2  today_start - ISO8601 UTC timestamp
collect_stories_for_product() {
  local pid=$1
  local today_start=$2
  local raw
  raw=$(retry_with_backoff zt_paginate "/products/$pid/stories" 100)
  local stories
  stories=$(echo "$raw" | jq '.stories // .')
  classify_stories "$stories" "$today_start"
}

export -f classify_stories collect_stories_for_product
