# AI Daily Digest — 视野情报提炼

> 把本周(WK_START ~ WK_END)的 AI Daily 日报压缩为 2~3 条"向外看"条目,用于周报 §向外看输入。

## 输入

```bash
AI_DAILY_DIR="${AI_DAILY_DIR:-$KNOWLEDGE_LIB/08-Research/AI-Daily/Daily}"
ls "$AI_DAILY_DIR"
```

> 前提:`KNOWLEDGE_LIB` 已由 `.env` 设置(必填,无 default)。

文件命名:`YYYY-MM-DD-ai-daily.md`,frontmatter 含 `created` 字段。

## 选片

抽出本周日期范围内的所有 AI Daily(注意 `WK_END` 是下周一 00:00 UTC,需排除):

```bash
WK_START_DATE="${WK_START:0:10}"   # YYYY-MM-DD
WK_END_DATE_EXCL="${WK_END:0:10}"  # 下周一,作为排除上界

DAILIES=$(find "$AI_DAILY_DIR" -name "*-ai-daily.md" -type f | sort | awk -F/ '{print $NF}' \
  | awk -v s="$WK_START_DATE" -v e="$WK_END_DATE_EXCL" \
        '{ d=substr($0,1,10); if (d>=s && d<e) print $0 }')

echo "本周 AI Daily 共 $(echo "$DAILIES" | grep -c .) 篇:"
echo "$DAILIES"
```

> 五一节、十一节、元旦等假期可能少于 7 篇,空缺正常。

## 提炼

LLM 任务:把这批 .md 读完,按以下规则压缩:

### 提炼原则

1. **跨多天反复出现**的同一主题,优先入选(说明是趋势而非新闻)。
2. **数字/事实/钱**优先(融资金额、ARR、估值、监管罚款、benchmark 分数)。
3. **跟我们业务有关**的优先(语义层面接近):
   - VOC / 评价数据 / 客服 AI / 多语种翻译
   - AI Agent / Agentic / 工作流 / 企业级落地
   - 模型成本 / 价格战 / 开源 vs 闭源
   - 中国 AI 监管 / 国产算力
4. **避免**:单纯产品发布无后续动作的、纯八卦无业务含义的、AI 安全玄学。

### 输出格式(每条)

```markdown
### N. {7~15 字标题,概括趋势}

**外部动态:**
- {事实 1,带数字/来源}
- {事实 2}
- {事实 3,可选}

**与我们的关联/启示:** {1~2 句,要有判断 — 不是"值得关注",而是"对 X 决策意味着 Y"}

**来源:** AI Daily MM-DD / MM-DD
```

### 数量与质量

- **2~3 条**(本周 ≤ 3 天 AI Daily 时降到 1~2 条)
- 每条 150~300 字
- 拒绝"AI 在加速发展"这种废话句

## 输出文件

```bash
# LLM 把生成的 markdown 写入:
echo "..." > /tmp/wk-outlook.md
```

后续渲染周报时,§向外看 板块直接 `cat /tmp/wk-outlook.md` 嵌入。

## 缺失处理

| 情况 | 处理 |
|---|---|
| 本周 AI Daily 0 篇(节假日全休) | §向外看 写一句"本周适逢{节日},AI Daily 暂停采集,视野板块本期跳过。" evaluation 扣 10 分,但允许通过 |
| 1~2 篇 | 1 条向外看,不强凑 |
| 3~7 篇 | 2~3 条向外看,正常 |
