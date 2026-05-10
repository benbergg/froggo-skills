#!/usr/bin/env bash
# check-weekly.sh — 7-assertion cross-check for V2 weekly report draft.
#
# Usage:
#   bash check-weekly.sh <draft.md> <weekly-{WK_NUM}.json>
#
# Exit codes:
#   0  all 7 pass
#   1  one or more failed
#   2  bad invocation / missing files / invalid JSON
#
# Output:
#   one line per check: "C{N} ✓"  or  "C{N} ✗ - reason"
#   final line: "RESULT: M/7 PASS" or "RESULT: M/7 FAIL"
#
# This script is the canonical implementation of the 7 assertions documented
# in SKILL.md § 自检 checklist. LLMs should call it instead of re-writing
# checks, because hand-rolled regex against a textual contract is the leading
# source of false negatives (e.g. C2's "id OR parent_id" rule).

# Note: not using `set -e` — grep returning 1 on "no match" is a normal
# control-flow signal in this script, not a fatal error.
set -uo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <draft.md> <weekly-{WK_NUM}.json>" >&2
  exit 2
fi

MD="$1"
JSON="$2"

[ -f "$MD" ]   || { echo "FATAL: MD not found: $MD"   >&2; exit 2; }
[ -f "$JSON" ] || { echo "FATAL: JSON not found: $JSON" >&2; exit 2; }
jq -e . "$JSON" >/dev/null 2>&1 || { echo "FATAL: invalid JSON: $JSON" >&2; exit 2; }

PASS_COUNT=0
FAIL_COUNT=0
ok()  { echo "C$1 ✓";          PASS_COUNT=$((PASS_COUNT + 1)); }
bad() { echo "C$1 ✗ - $2";     FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ---- C1 关键数据行 4 数字 == summary --------------------------------------
DATA_LINE=$(grep -E '本周关键数据[:：].*完成任务.*推进任务.*已解决.*Bug.*待跟进' "$MD" | head -1)
if [ -z "$DATA_LINE" ]; then
  bad 1 "未找到关键数据行(应含'本周关键数据:完成任务 X 个,推进任务 X 个,已解决 Bug X 个,待跟进 X 个')"
else
  read -r MD_DONE MD_PROG MD_RES MD_ACT <<< "$(echo "$DATA_LINE" | grep -oE '[0-9]+' | xargs)"
  read -r J_DONE J_PROG J_RES J_ACT <<< "$(jq -r '.summary | "\(.task_done) \(.task_progress) \(.bug_resolved) \(.bug_active)"' "$JSON")"
  if [ "$MD_DONE" = "$J_DONE" ] && [ "$MD_PROG" = "$J_PROG" ] && [ "$MD_RES" = "$J_RES" ] && [ "$MD_ACT" = "$J_ACT" ]; then
    ok 1
  else
    bad 1 "MD ($MD_DONE/$MD_PROG/$MD_RES/$MD_ACT) ≠ summary ($J_DONE/$J_PROG/$J_RES/$J_ACT)"
  fi
fi

# ---- C2 任务列表 id 完整 (id OR parent_id 任一在 MD 即合规) -----------------
# Build the set of T-ids referenced anywhere in the MD's task list.
MD_TIDS=$(grep -oE '【T[0-9]+】' "$MD" | grep -oE '[0-9]+' | sort -u)
# For each JSON task, accept if id OR parent_id (when > 0) is in MD_TIDS.
C2_MISSING=$(jq -c '[.tasks_done[], .tasks_progress[]] | .[] | {id, parent_id}' "$JSON" | \
  while IFS= read -r row; do
    ID=$(echo "$row" | jq -r .id)
    PID=$(echo "$row" | jq -r .parent_id)
    if echo "$MD_TIDS" | grep -qx "$ID"; then continue; fi
    if [ "$PID" -gt 0 ] 2>/dev/null && echo "$MD_TIDS" | grep -qx "$PID"; then continue; fi
    echo "T$ID(parent=$PID)"
  done | tr '\n' ' ' | sed 's/ $//')
J_TASKS_TOTAL=$(jq '[.tasks_done[], .tasks_progress[]] | length' "$JSON")
if [ "$J_TASKS_TOTAL" = "0" ]; then
  if grep -qE '本周暂无|节假日|假期|休息|缺勤' "$MD"; then
    ok 2
  else
    bad 2 "tasks_done+tasks_progress 为 0,但 MD 未含'暂无/节假日/假期/休息/缺勤'之一"
  fi
elif [ -z "$C2_MISSING" ]; then
  ok 2
else
  bad 2 "MD 漏任务: $C2_MISSING"
fi

# ---- C3 Bug id ------------------------------------------------------------
# Section extraction note: "**已解决:** ..." 与内容可能同行,所以 awk 不能用
# `next`(会跳过同行尾巴)。改为打开 flag 后本行也保留,直到 boundary 关闭。
RESOLVED_SECTION=$(awk '
  /\*\*已解决[:：]\*\*/ { f=1 }
  /\*\*待跟进[:：]\*\*/ { f=0 }
  f
' "$MD")
ACTIVE_SECTION=$(awk '
  /\*\*待跟进[:：]\*\*/ { f=1 }
  /^## / { f=0 }
  /\*\*本周关键数据/ { f=0 }
  /\*\*Bug 分析/ { f=0 }
  f
' "$MD")

MD_RESOLVED_IDS=$(echo "$RESOLVED_SECTION" | grep -oE 'B[0-9]+' | sort -u)
JSON_RESOLVED_IDS=$(jq -r '.bugs_resolved[].id' "$JSON" | sed 's/^/B/' | sort -u)
MD_ACTIVE_IDS=$(echo "$ACTIVE_SECTION" | grep -oE 'B[0-9]+' | sort -u)
JSON_ACTIVE_IDS=$(jq -r '.bugs_active[].id' "$JSON" | sed 's/^/B/' | sort -u)
JSON_ACTIVE_LEN=$(jq '.bugs_active | length' "$JSON")
JSON_RESOLVED_LEN=$(jq '.bugs_resolved | length' "$JSON")

C3_FAIL=""
# 已解决段
if [ "$JSON_RESOLVED_LEN" = "0" ]; then
  if [ -n "$MD_RESOLVED_IDS" ]; then
    C3_FAIL="已解决 应为 0 条但 MD 列了 [$MD_RESOLVED_IDS]"
  elif ! echo "$RESOLVED_SECTION" | grep -qE '暂无|节假日|假期'; then
    C3_FAIL="已解决 0 条但 MD 未含'暂无/节假日'声明"
  fi
elif [ "$(echo "$MD_RESOLVED_IDS")" != "$(echo "$JSON_RESOLVED_IDS")" ]; then
  MISS_R=$(comm -23 <(echo "$JSON_RESOLVED_IDS") <(echo "$MD_RESOLVED_IDS") | tr '\n' ' ')
  EXTRA_R=$(comm -13 <(echo "$JSON_RESOLVED_IDS") <(echo "$MD_RESOLVED_IDS") | tr '\n' ' ')
  [ -n "$MISS_R$EXTRA_R" ] && C3_FAIL="已解决 missing=[$MISS_R] extra=[$EXTRA_R]"
fi
# 待跟进段
if [ "$JSON_ACTIVE_LEN" = "0" ]; then
  if [ -n "$MD_ACTIVE_IDS" ]; then
    C3_FAIL="${C3_FAIL:+$C3_FAIL; }待跟进 应为 0 条但 MD 列了 [$MD_ACTIVE_IDS]"
  elif ! echo "$ACTIVE_SECTION" | grep -qE '暂无|节假日|假期'; then
    C3_FAIL="${C3_FAIL:+$C3_FAIL; }待跟进 0 条但 MD 未含'暂无/节假日'声明"
  fi
elif [ "$(echo "$MD_ACTIVE_IDS")" != "$(echo "$JSON_ACTIVE_IDS")" ]; then
  MISS_A=$(comm -23 <(echo "$JSON_ACTIVE_IDS") <(echo "$MD_ACTIVE_IDS") | tr '\n' ' ')
  EXTRA_A=$(comm -13 <(echo "$JSON_ACTIVE_IDS") <(echo "$MD_ACTIVE_IDS") | tr '\n' ' ')
  C3_FAIL="${C3_FAIL:+$C3_FAIL; }待跟进 missing=[$MISS_A] extra=[$EXTRA_A]"
fi
[ -z "$C3_FAIL" ] && ok 3 || bad 3 "$C3_FAIL"

# ---- C4 Bug 根因 4 行表 ---------------------------------------------------
# bash 3.2 (macOS default) lacks associative arrays — use a function instead.
c4_expected() {
  jq -r ".bug_root_cause[\"$1\"]" "$JSON"
}
C4_FAIL=""
for k in 代码缺陷 配置问题 需求缺失 非缺陷类; do
  MD_NUM=$(grep -E "^\| $k \|" "$MD" | head -1 | awk -F'|' '{gsub(/^ +| +$/,"",$3); print $3}')
  EXP=$(c4_expected "$k")
  if [ -z "$MD_NUM" ]; then
    C4_FAIL="${C4_FAIL:+$C4_FAIL; }表缺 $k 行"
  elif [ "$MD_NUM" != "$EXP" ]; then
    C4_FAIL="${C4_FAIL:+$C4_FAIL; }$k MD=$MD_NUM JSON=$EXP"
  fi
done
SUM=$(jq '[.bug_root_cause | to_entries[] | .value] | add' "$JSON")
BR=$(jq '.summary.bug_resolved' "$JSON")
[ "$SUM" != "$BR" ] && C4_FAIL="${C4_FAIL:+$C4_FAIL; }根因和 $SUM ≠ bug_resolved $BR"
[ -z "$C4_FAIL" ] && ok 4 || bad 4 "$C4_FAIL"

# ---- C5 下周计划 P0/P1/P2 各 ≥ 1 行非占位 --------------------------------
C5_FAIL=""
for p in P0 P1 P2; do
  ROW=$(awk '/^## 下周OKR计划/{f=1;next} /^## /{f=0} f && /^\|/{print}' "$MD" | grep -E "^\| ?$p ?\|" | head -1)
  CONTENT=$(echo "$ROW" | awk -F'|' '{gsub(/^ +| +$/,"",$3); print $3}')
  if [ -z "$ROW" ]; then
    C5_FAIL="${C5_FAIL:+$C5_FAIL; }缺 $p 行"
  elif [ -z "$CONTENT" ] || [ "$CONTENT" = "..." ] || echo "$CONTENT" | grep -qE '^（.*）$|^\(.*\)$|占位'; then
    C5_FAIL="${C5_FAIL:+$C5_FAIL; }$p 内容为占位"
  fi
done
[ -z "$C5_FAIL" ] && ok 5 || bad 5 "$C5_FAIL"

# ---- C6 完成情况说明 30~200 字 + 无 T 编号 + 无 zentao 状态词 -------------
#       + 空数据时必须含"暂无/节假日/假期/休息/缺勤"声明(防止 LLM 在零产出
#         的周编造业务主线;C2/C3 只校验任务/Bug 段,本规则补齐叙述段)
DESC=$(awk '/^完成情况说明[:：]/{f=1; next} /^### /{f=0} /^## /{f=0} f' "$MD" | tr -d '\n' | sed 's/^ *//;s/ *$//')
LEN=$(echo -n "$DESC" | wc -m | tr -d ' ')
C6_FAIL=""
if [ "$LEN" -lt 30 ]; then
  C6_FAIL="${C6_FAIL:+$C6_FAIL; }长度 $LEN < 30"
elif [ "$LEN" -gt 200 ]; then
  C6_FAIL="${C6_FAIL:+$C6_FAIL; }长度 $LEN > 200"
fi
echo "$DESC" | grep -qE 'T[0-9]+' && C6_FAIL="${C6_FAIL:+$C6_FAIL; }含 T 编号"
echo "$DESC" | grep -qiE '\bdoing\b|\bdone\b|\bwait\b|\bpause\b' && C6_FAIL="${C6_FAIL:+$C6_FAIL; }含 zentao 状态词"
# 空数据声明:零产出周必须显式说明,而非伪装成业务交付
TASKS_TOTAL=$(jq '(.tasks_done | length) + (.tasks_progress | length)' "$JSON")
if [ "$TASKS_TOTAL" = "0" ]; then
  if ! echo "$DESC" | grep -qE '暂无|节假日|假期|休息|缺勤'; then
    C6_FAIL="${C6_FAIL:+$C6_FAIL; }零产出周但完成情况说明未含'暂无/节假日/假期/休息/缺勤'声明"
  fi
fi
[ -z "$C6_FAIL" ] && ok 6 || bad 6 "$C6_FAIL"

# ---- C7 向外看 ≥ 2 条 (或合规跳过) ----------------------------------------
OUTLOOK_N=$(awk '/^## 向外看输入/{f=1;next} /^## /{f=0} f && /^### [0-9]+\./{print}' "$MD" | wc -l | tr -d ' ')
HAS_DYN=$(awk '/^## 向外看输入/{f=1;next} /^## /{f=0} f' "$MD" | grep -c '外部动态' || true)
HAS_HINT=$(awk '/^## 向外看输入/{f=1;next} /^## /{f=0} f' "$MD" | grep -cE '关联|启示' || true)
HAS_SRC=$(awk '/^## 向外看输入/{f=1;next} /^## /{f=0} f' "$MD" | grep -c '来源[:：]' || true)
SKIP_DECLARED=$(awk '/^## 向外看输入/{f=1;next} /^## /{f=0} f' "$MD" | grep -cE 'AI Daily 暂停采集|节假日|假期' || true)
C7_FAIL=""
if [ "$OUTLOOK_N" -lt 2 ]; then
  if [ "$SKIP_DECLARED" -ge 1 ]; then
    : # 合规跳过
  else
    C7_FAIL="${C7_FAIL:+$C7_FAIL; }向外看条数 $OUTLOOK_N < 2 且无'AI Daily 暂停采集'声明"
  fi
fi
if [ "$OUTLOOK_N" -ge 2 ]; then
  [ "$HAS_DYN" -ge "$OUTLOOK_N" ] || C7_FAIL="${C7_FAIL:+$C7_FAIL; }外部动态行数 $HAS_DYN < $OUTLOOK_N"
  [ "$HAS_HINT" -ge "$OUTLOOK_N" ] || C7_FAIL="${C7_FAIL:+$C7_FAIL; }关联/启示行数 $HAS_HINT < $OUTLOOK_N"
  [ "$HAS_SRC" -ge "$OUTLOOK_N" ]  || C7_FAIL="${C7_FAIL:+$C7_FAIL; }来源行数 $HAS_SRC < $OUTLOOK_N"
fi
[ -z "$C7_FAIL" ] && ok 7 || bad 7 "$C7_FAIL"

# ---- summary --------------------------------------------------------------
TOTAL=$((PASS_COUNT + FAIL_COUNT))
if [ "$FAIL_COUNT" = "0" ]; then
  echo "RESULT: $PASS_COUNT/$TOTAL PASS"
  exit 0
else
  echo "RESULT: $PASS_COUNT/$TOTAL FAIL"
  exit 1
fi
