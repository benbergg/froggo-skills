# Evaluation — 周报评测

> 阻断闸:< 80 分不保存、不推送。最多迭代 2 轮,再失败上报用户人工介入。

## 评分维度

| # | 维度 | 满分 | 自动可检 | 关键检查 |
|---|---|---|---|---|
| 1 | Frontmatter 完整 | 10 | ✓ | created/updated/status/project/tags/week/aliases 全有 |
| 2 | 任务列表非空或合理空 | 15 | ✓ | R1 ≥ 1 项;若为空,正文必须出现"暂无"+"假期/缺勤"关键字 |
| 3 | 任务格式正确 | 10 | ✓ | 每行匹配 `【T\d+】.+(/.+)?` |
| 4 | Bug 拆分齐全 | 10 | ✓ | "已解决"/"待跟进" 两个标题都在;数字与 R2/R3 长度一致 |
| 5 | 关键数据行存在 | 5 | ✓ | 匹配 `完成任务 \d+ 个 \| 已解决 Bug \d+ 个 \| 待跟进 \d+ 个`(允许半角空格) |
| 6 | Bug 根因 4 行 | 10 | ✓ | 表格里"代码缺陷/配置问题/非缺陷类/需求缺失"4 行,数字之和 = R2 总数 |
| 7 | AI 应用 ≥ 4 行 | 5 | ✓ | 表格(去表头/分隔)行数 ≥ 4 |
| 8 | 下周计划 P0/P1/P2 齐 | 10 | ✓ | 三档都有,每档至少 1 行有内容(非占位) |
| 9 | 向外看 ≥ 2 条 | 10 | ✓ | `### N.` 出现 ≥ 2 次;每条含"外部动态"和"启示" |
| 10 | 字数 ≥ 1500 | 5 | ✓ | 防止空报 |
| 11 | 完成情况说明非占位 | 5 | ✗(LLM 评) | "完成情况说明:"后 2~3 句话,有判断,不是流水账 |
| 12 | 向外看判断质量 | 5 | ✗(LLM 评) | 每条"启示"行不是"值得关注/重要"等空话 |

**满分 100,达标 ≥ 80。**

## 自动检查脚本

存为 `references/scripts/eval.sh`(由 SKILL 引用,这里给出全文,落地到子目录时复制):

```bash
#!/usr/bin/env bash
# usage: eval.sh <weekly-report.md> [--r1 /tmp/wk-R1.json] [--r2 ...] [--r3 ...]
# 输出: JSON {score, passed, issues[]}
set -euo pipefail

FILE="$1"; shift
R1=/tmp/wk-R1.json R2=/tmp/wk-R2.json R3=/tmp/wk-R3.json
while [ $# -gt 0 ]; do
  case "$1" in
    --r1) R1="$2"; shift 2 ;;
    --r2) R2="$2"; shift 2 ;;
    --r3) R3="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done

[ -f "$FILE" ] || { echo "{\"score\":0,\"passed\":false,\"issues\":[\"file not found: $FILE\"]}"; exit 0; }

issues=()
score=0
add() { score=$((score + $1)); }
miss() { issues+=("$1"); }

CONTENT=$(cat "$FILE")

# 1. Frontmatter (10)
fm_required=(created updated status project tags week aliases)
fm_ok=1
for k in "${fm_required[@]}"; do
  grep -qE "^${k}:" "$FILE" || { fm_ok=0; miss "frontmatter 缺 $k"; }
done
[ $fm_ok -eq 1 ] && add 10

# 2. 任务列表非空或合理空 (15)
n_tasks=$(grep -cE '^- 【T[0-9]+】' "$FILE" || true)
n_r1=$(jq 'length' "$R1" 2>/dev/null || echo 0)
if [ "$n_r1" -gt 0 ] && [ "$n_tasks" -ge "$n_r1" ]; then
  add 15
elif [ "$n_r1" -eq 0 ] && grep -qE '本周(暂无|节假日|休息|假期)' "$FILE"; then
  add 12   # 空但有合理说明
else
  miss "任务列表数 ($n_tasks) 与 R1 ($n_r1) 不一致或空且无说明"
fi

# 3. 任务格式 (10)
bad_fmt=$(grep -E '^- 【T' "$FILE" | grep -vE '^- 【T[0-9]+】' | head -3 || true)
if [ -z "$bad_fmt" ]; then add 10; else miss "任务格式不规范: $bad_fmt"; fi

# 4. Bug 拆分齐全 (10)
if grep -q '已解决' "$FILE" && grep -q '待跟进' "$FILE"; then add 10
else miss "Bug 缺已解决/待跟进 拆分"; fi

# 5. 关键数据行 (5)
if grep -qE '完成任务[ ]*[0-9]+[ ]*个' "$FILE" && grep -qE '已解决 ?Bug[ ]*[0-9]+[ ]*个' "$FILE"; then
  add 5
else miss "缺关键数据行"; fi

# 6. Bug 根因 4 行 (10)
roots=("代码缺陷" "配置问题" "非缺陷类" "需求缺失")
all=1
for r in "${roots[@]}"; do grep -q "| $r" "$FILE" || { all=0; miss "Bug 根因表缺 $r"; }; done
[ $all -eq 1 ] && add 10

# 7. AI 应用 ≥ 4 行 (5)
ai_rows=$(awk '/^## AI在当周工作中的应用/{flag=1;next} /^## /{flag=0} flag && /^\|/{print}' "$FILE" \
  | grep -vE '^\|[ -:|]+\|$' | grep -vE '^\| 应用场景' | wc -l)
[ "$ai_rows" -ge 4 ] && add 5 || miss "AI 应用行数 $ai_rows < 4"

# 8. 下周计划 P0/P1/P2 (10)
p_ok=1
for p in P0 P1 P2; do
  awk -v p="$p" '/^## 下周OKR计划/{flag=1;next} /^## /{flag=0} flag && /^\|/{print}' "$FILE" \
    | grep -qE "^\| $p \|" || { p_ok=0; miss "下周计划缺 $p"; }
done
[ $p_ok -eq 1 ] && add 10

# 9. 向外看 ≥ 2 条 (10)
outlook_n=$(awk '/^## 向外看输入/{flag=1;next} /^## /{flag=0} flag && /^### [0-9]+\./{print}' "$FILE" | wc -l)
if [ "$outlook_n" -ge 2 ] && grep -q '外部动态' "$FILE" && grep -qE '关联|启示' "$FILE"; then
  add 10
else miss "向外看 $outlook_n < 2 或缺外部动态/启示字段"; fi

# 10. 字数 ≥ 1500 (5)
chars=$(wc -m < "$FILE" | tr -d ' ')
[ "$chars" -ge 1500 ] && add 5 || miss "字数 $chars < 1500"

passed=false
[ $score -ge 80 ] && passed=true

jq -n --arg s "$score" --arg p "$passed" --argjson i "$(printf '%s\n' "${issues[@]}" | jq -R . | jq -s .)" \
  '{score: ($s|tonumber), passed: ($p|test("true")), issues: $i}'
```

## 人工/LLM 复评

第 11、12 项不能机器判断,LLM 拿 `score >= 80` 的稿子再过一遍以下问题:

1. "完成情况说明" 是不是 2~3 句、有判断、不是把任务列表复述一遍?
2. 向外看每条"启示" 是不是说出了"对 X 决策意味着 Y"?
3. 任务/Bug 标题改写后语义有没有偏离原始 title?(抽样 3 个对照 R1/R2 原数据)
4. 数字校对:任务数 == R1 长度;已解决 Bug 数 == R2 长度;待跟进 == R3 长度;Bug 根因表数字之和 == R2 长度?

LLM 自评有问题就回到生成步骤迭代,最多 2 轮。

## 节假日/缺勤豁免

R1/R2 同时为空 + 正文有"假期/节假日/缺勤"关键字时:
- 第 2 项给 12 分(而非 15)
- 第 3、4、6 项跳过(给满分,因为没数据可评)
- 第 11 项必须解释清楚为什么没数据

最低保留分:67(节假日豁免后理论上限 87,实际通常 75~85,可过 80 闸)。

## 报告格式

`eval.sh` 输出:

```json
{
  "score": 87,
  "passed": true,
  "issues": ["AI 应用行数 3 < 4"]
}
```

未通过示例:

```json
{
  "score": 62,
  "passed": false,
  "issues": [
    "frontmatter 缺 aliases",
    "Bug 根因表缺 需求缺失",
    "字数 1102 < 1500"
  ]
}
```
