#!/usr/bin/env bash
DIR=$(cd "$(dirname "$0")" && pwd)
source "$DIR/_assert.sh"
source "$DIR/../references/scripts/check.sh"

test_start "test-evaluation"

# 1. frontmatter compliance
md_good=$(cat <<'EOF'
---
created: 2026-05-05T18:00:00+08:00
updated: 2026-05-05T18:00:00+08:00
type: daily-report
date: 2026-05-05
products: [95]
tags: [日报]
status: published
---
# 产研日报 · 2026-05-05
[[S1234]] [[B5678]] [[T8001]]
EOF
)
score=$(score_frontmatter "$md_good")
assert_eq "$score" "10" "frontmatter all 5 fields → 10"

md_bad=$(cat <<'EOF'
---
type: daily-report
---
no created/updated/date/products/tags
EOF
)
score=$(score_frontmatter "$md_bad")
assert_eq "$score" "2" "1 of 5 → 2"

# 2. wikilink compliance
score=$(score_wikilinks "$md_good")
assert_eq "$score" "10" "all wikilinks correct"
md_no_link="纯文本 S1234 B5678 没有 wikilink"
score=$(score_wikilinks "$md_no_link")
assert_eq "$score" "0" "no wikilinks → 0"

# 3. feishu summary length
short="📊 产研日报 简短"
score=$(score_summary_length "$short")
assert_eq "$score" "10" "short summary → 10"
long=$(printf 'x%.0s' {1..300})
score=$(score_summary_length "$long")
assert_eq "$score" "0" "300 chars > 200 → 0"

# 4. progress sanity source-weighted
# stage strict: closed must be 100
agg_stage_ok='{"products":[{"stories":{"in_progress":[],"today_done":[{"id":1,"stage":"closed","progress":{"value":100,"source":"stage"}}],"unassigned":[],"idle":[]}}]}'
score=$(score_progress "$agg_stage_ok")
assert_eq "$score" "15" "stage closed=100 → full"
agg_stage_bad='{"products":[{"stories":{"in_progress":[],"today_done":[{"id":1,"stage":"closed","progress":{"value":80,"source":"stage"}}],"unassigned":[],"idle":[]}}]}'
score=$(score_progress "$agg_stage_bad")
assert_eq "$score" "5" "stage closed≠100 → partial(strict)"

# hours lenient: middle stage is lenient, no violation
agg_hours_lenient='{"products":[{"stories":{"in_progress":[{"id":1,"stage":"testing","progress":{"value":25,"source":"hours"}}],"today_done":[],"unassigned":[],"idle":[]}}]}'
score=$(score_progress "$agg_hours_lenient")
assert_eq "$score" "15" "hours testing 25%(out of stage range) → still pass(lenient)"

test_end
