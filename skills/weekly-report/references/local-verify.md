# Local Verify — 本地 dry-run 流程

> 部署到 openclaw 之前,在本机跑通完整流程并通过 evaluation,**不动**生产 Knowledge-Library。

## 0. 前提

```bash
# 0.1 凭据(本机用 ~/.zentao.env;生产用 ~/.openclaw/.env)
cat > ~/.zentao.env <<'EOF'
ZENTAO_BASE_URL=https://chandao.bytenew.com/zentao/api.php/v1
ZENTAO_ACCOUNT=<你的账号>
ZENTAO_PASSWORD=<你的密码>
EOF
chmod 600 ~/.zentao.env

# 0.2 知识库(本机若无可指向只读 clone 或临时目录)
export KNOWLEDGE_LIB="${KNOWLEDGE_LIB:-$HOME/Knowledge-Library}"
[ -d "$KNOWLEDGE_LIB" ] || echo "WARN: KNOWLEDGE_LIB 不存在,将跳过 AI Daily 摘要,只跑禅道部分"

# 0.3 工具
which curl jq >/dev/null && echo "✓ curl/jq OK"
```

## 1. source zentao-api 函数库

V4 后函数已抽到 `scripts/zt-functions.sh`，**直接 source 即可**（不再需要从 markdown 抽 bash 块）：

```bash
ZENTAO_SKILL_DIR=/Users/lg/workspace/froggo-skills/skills/zentao-api
# shellcheck source=/dev/null
source "$ZENTAO_SKILL_DIR/scripts/zt-functions.sh"

# 校验
type zt_init zt_acquire_token zt_get zt_paginate zt_write zt_week_range >/dev/null \
  && echo "✓ 6 函数已加载"
```

> V3 及更早的"从 markdown 抽 bash 块再 eval"方式已废弃；现在直接 source 函数库即可。如需 quickstart 文档详见 `$ZENTAO_SKILL_DIR/references/quickstart.md`。

## 2. Setup

```bash
set -a; source ~/.zentao.env; set +a
zt_init && zt_acquire_token >/dev/null

ME="${ZENTAO_ME:-$(zt_get /user | jq -r .profile.account)}"
zt_week_range
WK_NUM=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$WK_START" "+%G-W%V" 2>/dev/null \
       || date -d "$WK_START" "+%G-W%V")
export ME WK_NUM
echo "ME=$ME WK=$WK_NUM 本周=$WK_START~$WK_END 下周=$NEXT_S~$NEXT_E"
```

## 3. 跑五块采集

按 `data-collection.md` 顺序粘贴 R1 → R2 → R3 → R4 → R5 → format。每段跑完都 `jq 'length'` 检视计数。

```bash
# 采集后产物自检:
ls -la /tmp/wk-*.json
for f in /tmp/wk-R{1,2,3,4}.json; do
  echo "$f: $(jq 'length' "$f") 条"
done
```

**异常分流**:
- 任一文件不存在或非法 JSON → 回看采集步骤错误
- 0 条 + 非节假日 → 检查 `$ME` 是否取对、`view.sprints` ∩ `executions` 是否非空
- `view.sprints` 为空 → 账号无可见迭代,周报必然为空

## 4. 生成周报草稿

LLM 任务,按 `template.md` 渲染。dry-run 输出到 `/tmp`,**不写知识库**:

```bash
DRAFT="/tmp/${WK_NUM}-工作周报.md"
# LLM 把渲染好的 markdown 写入 $DRAFT
```

## 5. 跑 evaluation

```bash
EVAL_SH="/Users/lg/workspace/froggo-skills/skills/weekly-report/references/scripts/eval.sh"
bash "$EVAL_SH" "$DRAFT" \
  --r1 /tmp/wk-R1.json --r2 /tmp/wk-R2.json --r3 /tmp/wk-R3.json \
  | tee /tmp/wk-eval.json

PASSED=$(jq -r .passed /tmp/wk-eval.json)
SCORE=$(jq -r .score /tmp/wk-eval.json)
echo "评分: $SCORE  通过: $PASSED"
```

**门槛 ≥ 80**。未通过则:
1. 看 `.issues[]` 修哪几项
2. 重新生成 → 重跑 eval
3. 最多 2 轮迭代,再失败上报用户

## 6. 跟上周报告 diff(回归检查)

```bash
LAST_WK_FILE=$(ls "$KNOWLEDGE_LIB/05-Reports/weekly/" 2>/dev/null \
  | grep -E '^[0-9]{4}-W[0-9]{2}-工作周报\.md$' | sort | tail -1)

if [ -n "$LAST_WK_FILE" ]; then
  echo "上周: $LAST_WK_FILE"
  diff -u "$KNOWLEDGE_LIB/05-Reports/weekly/$LAST_WK_FILE" "$DRAFT" | head -100
fi
```

人工确认:
- frontmatter 结构无回退
- 板块数与顺序一致
- 没有奇怪的英文块/未渲染占位

## 7. 抽样人工校对(必做,3 条)

```bash
# 任务抽样
jq -r '.[:3] | .[] | "T\(.id) finishedBy=\(.finishedBy // "?") finishedDate=\(.finishedDate)"' /tmp/wk-R1.json
# 拿这 3 个 ID 去禅道网页确认: 名称对 / finishedBy 是本人 / 日期在本周

# Bug 抽样
jq -r '.[:3] | .[] | "B\(.id) resolvedBy=\(.resolvedBy) resolvedDate=\(.resolvedDate) title=\(.title)"' /tmp/wk-R2.json

# 待跟进抽样
jq -r '.[:3] | .[] | "B\(.id) status=\(.status) assignedTo=\(.assignedTo) title=\(.title)"' /tmp/wk-R3.json
```

3 条全对 → 通过。任一不对 → 回采集步骤排查 jq 筛选条件。

## 8. 部署条件

以下全部满足才允许部署到 openclaw:

- [ ] eval `score >= 80` 且 `passed: true`
- [ ] 抽样 3 任务 + 3 Bug 全对
- [ ] diff 上周报告无格式回退
- [ ] 当前禅道凭据可登录(token 取得成功)
- [ ] 本机能复现完整流程(SKILL.md 步骤可走通,无依赖断链)

部署步骤见 [`../../weekly-report/SKILL.md`](../SKILL.md) 末尾(待补)和团队约定。

## 9. 常见问题排查

| 症状 | 原因 | 修法 |
|---|---|---|
| `zt_acquire_token` 报 FATAL | 密码错/账号锁 | 改 `~/.zentao.env`,重 source |
| HTTP 400 / 不返 JSON | 本机代理拦截 | snippet 已带 `--noproxy '*'`,确认未被覆盖 |
| `/programs` jq parse error | Zentao 字段嵌 0x01-0x1f | `zt_get` 已 strip,不应再现;若有,看 troubleshooting §11 |
| R1 总是 0 但你确实完成了任务 | `view.sprints` 不含完成任务的执行 | 该执行非 doing 状态,或不在你 view 里;手工补 SID |
| `zt_week_range` 报 date 错 | 系统 date 既非 BSD 也非 GNU(罕见) | 检查 `which date`,可能装的是 busybox |
| jq parse `.parent: -1` 当成子任务 | 误用 `!= 0` | 改用 `> 0`(P3 sentinel) |
| eval `字数 X < 1500` | 草稿太空 | LLM 补"完成情况说明"和向外看具体描述 |
| eval `Bug 根因表缺 XX` | 模板变形 | 严格按 template.md §1.2 渲染 |
| diff 出现大量空白差异 | 行尾差异(CRLF/LF) | `dos2unix` 或 `sed -i 's/\r$//'` |
