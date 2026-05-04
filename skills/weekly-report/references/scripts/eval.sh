#!/usr/bin/env bash
# eval.sh — 周报自动评测
# usage: eval.sh <weekly-report.md> [--r1 /tmp/wk-R1.json] [--r2 ...] [--r3 ...]
# 输出: JSON {score, passed, issues[]} 到 stdout
# 退出码: 0 始终(无论是否 passed,JSON 已表达结果)

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <weekly-report.md> [--r1 path] [--r2 path] [--r3 path]" >&2
  exit 2
fi

FILE="$1"; shift
R1=/tmp/wk-R1.json
R2=/tmp/wk-R2.json
R3=/tmp/wk-R3.json

while [ $# -gt 0 ]; do
  case "$1" in
    --r1) R1="$2"; shift 2 ;;
    --r2) R2="$2"; shift 2 ;;
    --r3) R3="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$FILE" ]; then
  jq -n --arg f "$FILE" '{score:0, passed:false, issues:["file not found: \($f)"]}'
  exit 0
fi

issues=()
score=0
add() { score=$((score + $1)); }
miss() { issues+=("$1"); }

# 1. Frontmatter (10)
fm_required=(created updated status project tags week aliases)
fm_ok=1
for k in "${fm_required[@]}"; do
  grep -qE "^${k}:" "$FILE" || { fm_ok=0; miss "frontmatter 缺 $k"; }
done
[ $fm_ok -eq 1 ] && add 10

# 节假日/缺勤检测
holiday_mode=0
n_r1=$(jq 'length' "$R1" 2>/dev/null || echo 0)
n_r2=$(jq 'length' "$R2" 2>/dev/null || echo 0)
n_r3=$(jq 'length' "$R3" 2>/dev/null || echo 0)
if [ "$n_r1" -eq 0 ] && [ "$n_r2" -eq 0 ] \
   && grep -qE '本周(暂无|节假日|休息|假期)|劳动节|春节|国庆|元旦|端午|中秋|清明' "$FILE"; then
  holiday_mode=1
fi

# 2. 任务列表非空或合理空 (15 / 节假日 12)
n_tasks=$(grep -cE '^- 【T[0-9]+】' "$FILE" || true)
if [ "$n_r1" -gt 0 ] && [ "$n_tasks" -ge "$n_r1" ]; then
  add 15
elif [ "$n_r1" -eq 0 ] && [ "$holiday_mode" -eq 1 ]; then
  add 12
elif [ "$n_r1" -eq 0 ]; then
  miss "R1 任务为 0 且正文未注明假期/缺勤"
else
  miss "任务列表数 ($n_tasks) 少于 R1 ($n_r1)"
fi

# 3. 任务格式 (10) - 节假日跳过
if [ "$holiday_mode" -eq 1 ]; then
  add 10
else
  bad_fmt=$(grep -E '^- 【T' "$FILE" | grep -vE '^- 【T[0-9]+】' | head -3 || true)
  if [ -z "$bad_fmt" ]; then add 10; else miss "任务格式不规范: $bad_fmt"; fi
fi

# 4. Bug 拆分齐全 (10) - 节假日跳过
if [ "$holiday_mode" -eq 1 ]; then
  add 10
else
  if grep -q '已解决' "$FILE" && grep -q '待跟进' "$FILE"; then
    add 10
  else
    miss "Bug 缺 已解决/待跟进 拆分"
  fi
fi

# 5. 关键数据行 (5)
if grep -qE '完成任务[ ]*[0-9]+[ ]*个' "$FILE" \
   && grep -qE '已解决 ?Bug[ ]*[0-9]+[ ]*个' "$FILE"; then
  add 5
else
  miss "缺关键数据行(完成任务 X 个 / 已解决 Bug X 个)"
fi

# 6. Bug 根因 4 行 (10) - 节假日跳过
if [ "$holiday_mode" -eq 1 ]; then
  add 10
else
  roots=("代码缺陷" "配置问题" "非缺陷类" "需求缺失")
  all=1
  for r in "${roots[@]}"; do
    grep -q "| $r" "$FILE" || { all=0; miss "Bug 根因表缺 $r"; }
  done
  [ $all -eq 1 ] && add 10
fi

# 7. AI 应用 ≥ 4 行 (5)
ai_rows=$(awk '/^## AI在当周工作中的应用/{flag=1;next} /^## /{flag=0} flag && /^\|/{print}' "$FILE" \
  | grep -vE '^\|[-: |]+\|$' | grep -vE '^\| 应用场景' | wc -l | tr -d ' ')
if [ "$ai_rows" -ge 4 ]; then
  add 5
else
  miss "AI 应用行数 $ai_rows < 4"
fi

# 8. 下周计划 P0/P1/P2 (10)
p_ok=1
for p in P0 P1 P2; do
  awk -v p="$p" '/^## 下周OKR计划/{flag=1;next} /^## /{flag=0} flag && /^\|/{print}' "$FILE" \
    | grep -qE "^\| $p \|" || { p_ok=0; miss "下周计划缺 $p"; }
done
[ $p_ok -eq 1 ] && add 10

# 9. 向外看 ≥ 2 条 (10)
outlook_n=$(awk '/^## 向外看输入/{flag=1;next} /^## /{flag=0} flag && /^### [0-9]+\./{print}' "$FILE" \
  | wc -l | tr -d ' ')
if [ "$outlook_n" -ge 2 ] && grep -q '外部动态' "$FILE" && grep -qE '关联|启示' "$FILE"; then
  add 10
else
  miss "向外看 $outlook_n < 2 或缺 外部动态/启示 字段"
fi

# 10. 字数 ≥ 1500 (5)
chars=$(wc -m < "$FILE" | tr -d ' ')
if [ "$chars" -ge 1500 ]; then
  add 5
else
  miss "字数 $chars < 1500"
fi

passed=false
[ $score -ge 80 ] && passed=true

# 把 issues 数组转 JSON
if [ ${#issues[@]} -eq 0 ]; then
  issues_json='[]'
else
  issues_json=$(printf '%s\n' "${issues[@]}" | jq -R . | jq -s .)
fi

jq -n \
  --argjson s "$score" \
  --argjson p "$passed" \
  --argjson i "$issues_json" \
  --argjson h "$holiday_mode" \
  '{score: $s, passed: $p, holiday_mode: ($h == 1), issues: $i}'
