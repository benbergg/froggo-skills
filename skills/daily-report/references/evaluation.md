# Evaluation

## 8 维度详表(总 100)

| 检查项 | 权重 | 通过条件 |
|--------|------|----------|
| 数据完整性 | 25 | 四类需求总和 == D1 范围内总数 |
| 时间准确性 | 15 | 今日 date 字段在合法范围 |
| 进度合理性 | 15 | source 调权(见下) |
| 需求范围分类完整性 | 10 | 四类无重叠且并集 == 活跃需求总数 |
| Frontmatter 合规 | 10 | 5 字段必填 |
| 飞书摘要长度 | 10 | ≤ 200 字 |
| Wikilink 格式 | 10 | 所有 ID `[[...]]` |
| Task 渲染合规 | 5 | task.type 不空 |

## 进度合理性 source 调权

| source | 严格度 | 规则 | 违规扣分 |
|--------|-------|------|----------|
| stage | 严格 | wait=0 / closed=100 / 中间 stage 等于映射 | -10 |
| count | 中 | closed 必 100 | -5 |
| hours | 宽松 | 仅校 closed=100 / wait<30 | -5 |

## 阈值与失败处理

- 阈值:**70 分**
- 失败:迭代 1 轮;仍失败 → 草稿 `/tmp/daily-${DATE}.draft.md`,cron 模式飞书告警

## 调用脚本

```bash
source references/scripts/check.sh
score=$(score_total /tmp/daily-${DATE}.md /tmp/daily-${DATE}.aggregated.json /tmp/daily-${DATE}.summary.txt)
if [ "$score" -lt 70 ]; then
  echo "FAIL: $score"
  exit 1
fi
```
