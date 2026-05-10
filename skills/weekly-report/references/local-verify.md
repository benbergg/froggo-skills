# Local Verify — V2 本机 dry-run 流程

> 部署到 openclaw / 写入知识库之前,在本机跑通完整流程并通过 7 项断言自检,**不动**生产 Knowledge-Library。

## 0. 前提

```bash
# 0.1 凭据(本机 ~/.zentao.env;生产 ~/.openclaw/.env)
cat > ~/.zentao.env <<'EOF'
ZENTAO_BASE_URL=https://chandao.bytenew.com/zentao/api.php/v1
ZENTAO_ACCOUNT=<你的账号>
ZENTAO_PASSWORD=<你的密码>
EOF
chmod 600 ~/.zentao.env

# 0.2 知识库(必填,本机与服务器路径不同)
[ -n "$KNOWLEDGE_LIB" ] || { echo "FATAL: KNOWLEDGE_LIB not set; add to ~/.zentao.env (本机) 或 ~/.openclaw/.env (服务器)" >&2; exit 1; }

# 0.3 工具(node 18+ 与 jq)
node --version | grep -E 'v(1[89]|2[0-9])' >/dev/null && echo "✓ node OK"
which jq >/dev/null && echo "✓ jq OK"
```

## 1. 加载凭据

```bash
set -a; source ~/.zentao.env; set +a
```

`collect-weekly.js` 会自动 source `~/.openclaw/.env` 与 `~/.zentao.env`(脚本内置 loadEnvFile),即使 shell 没 export 也能跑。

## 2. 跑数据采集

```bash
SCRIPT=/Users/lg/workspace/froggo-skills/skills/weekly-report/references/scripts/collect-weekly.js

# 本周(默认):
node "$SCRIPT" --out /tmp/weekly-current.json

# 历史周:
node "$SCRIPT" --week 2026-W18 --out /tmp/weekly-2026-W18.json
```

stdout 末行示例:
```
OK week=2026-W19 me=qingwa api_calls=87 done=5 progress=3 bug_resolved=6 bug_active=4 next=7 → /tmp/weekly-2026-W19.json
```

**异常分流**(按 exit code):
- `exit 1` `FATAL: env ZENTAO_BASE_URL is required` → `~/.zentao.env` 没 source
- `exit 1` `FATAL: failed to acquire token via zentao-api bridge` → `rm ~/.cache/zentao/token.json` 后再跑;还失败 → 检查账号密码
- `exit 4` `FATAL: hard timeout (600000ms) reached` → 单次跑超 10 分钟,看 `_meta.skipped` 哪些 endpoint 卡住,可调 `WEEKLY_HARD_TIMEOUT_MS`
- **`exit 5` `FATAL: WEEKLY_API_BUDGET=N exhausted`** → API 预算触顶导致数据残缺。`/tmp/weekly-{WK}.json` **已写盘可看**但 `_meta.budget_exceeded=true`、bugs 几乎全 0。**正确处理**:`WEEKLY_API_BUDGET=4000 node collect-weekly.js ...` 重跑(或更高,看 stderr 推荐值)。**调试场景**可加 `--allow-partial` 或 `WEEKLY_ALLOW_PARTIAL=1` 绕过(用于排查 budget 之外的字段映射 bug)
- `exit 0` 但 `done=0 progress=0 bug_resolved=0 bug_active=0` → 真正空数据(节假日 / view 无任何数据),或 `me` 字段错了。检查 stdout `me=` 与 `mySprints=N` trace

## 3. 校验 JSON schema

```bash
WK_NUM=$(jq -r .week /tmp/weekly-2026-W19.json)
echo "周编号: $WK_NUM"

# 顶层字段齐全
jq 'keys' /tmp/weekly-2026-W19.json
# 期望: ["_meta","bug_root_cause","bugs_active","bugs_resolved","me","next_e","next_s","summary","tasks_done","tasks_next_week","tasks_progress","week","wk_end","wk_start"]

# summary ground truth
jq .summary /tmp/weekly-2026-W19.json
# 期望: { task_done, task_progress, bug_resolved, bug_active, next_planned } 5 个数字

# bug_root_cause 4 key 之和 == bug_resolved
jq '[.bug_root_cause | to_entries[] | .value] | add as $sum | {sum: $sum, bug_resolved: .summary.bug_resolved}' /tmp/weekly-2026-W19.json
# 期望: sum == bug_resolved
```

## 4. AI 撰写草稿

LLM 任务,按 [SKILL.md § 模板原文 + § 撰写约束](../SKILL.md) 渲染。dry-run 输出到 `/tmp`,**不写知识库**:

```bash
DRAFT="/tmp/weekly-${WK_NUM}.md"
# LLM 把渲染好的 markdown 写入 $DRAFT
```

## 5. 跑 7 项断言自检

```bash
bash /Users/lg/workspace/froggo-skills/skills/weekly-report/references/scripts/check-weekly.sh \
  "$DRAFT" "/tmp/weekly-${WK_NUM}.json"
```

退出码:`0` = 7/7 PASS、`1` = 任一 FAIL、`2` = 调用错误。

每轮 LLM 不再手写规则,只读 stdout 的 `C{N} ✗ - reason` 行,改写对应段,再跑。3 轮上限,失败上报用户。详见 [SKILL.md § 自检 checklist](../SKILL.md)。

## 6. 跟上周报告 diff(回归检查)

```bash
LAST_WK_FILE=$(ls "$KNOWLEDGE_LIB/05-Reports/weekly/" 2>/dev/null \
  | grep -E '^[0-9]{4}-W[0-9]{2}-工作周报\.md$' | sort | tail -1)

if [ -n "$LAST_WK_FILE" ]; then
  echo "上周: $LAST_WK_FILE"
  diff -u "$KNOWLEDGE_LIB/05-Reports/weekly/$LAST_WK_FILE" "$DRAFT" | head -100
fi
```

人工确认:frontmatter 结构无回退、板块数与顺序一致、没有未渲染占位。

## 7. 抽样人工校对(必做,3 条)

```bash
# 任务抽样(校对 finishedBy 是本人、日期在本周)
jq -r '.tasks_done[:3] | .[] | "T\(.id) finishedBy=\(.finishedBy) finishedDate=\(.finishedDate) display_path=\(.display_path)"' /tmp/weekly-${WK_NUM}.json

# Bug 抽样(校对 resolvedBy 是本人、日期在本周)
jq -r '.bugs_resolved[:3] | .[] | "B\(.id) resolvedBy=\(.resolvedBy) resolvedDate=\(.resolvedDate) type=\(.type) title=\(.title_raw)"' /tmp/weekly-${WK_NUM}.json

# 待跟进抽样(校对 status=active、assignedTo 是本人)
jq -r '.bugs_active[:3] | .[] | "B\(.id) status=\(.status) assignedTo=\(.assignedTo) title=\(.title_raw)"' /tmp/weekly-${WK_NUM}.json
```

3 条全对 → 通过。任一不对 → 检查 collect-weekly.js 的 me/range 计算或字段映射。

## 8. 部署条件

以下全部满足才允许保存到知识库 + git push:

- [ ] 7 项断言全过(或合规跳过 C7)
- [ ] 抽样 3 任务 + 3 Bug 全对
- [ ] diff 上周报告无格式回退
- [ ] `_meta.skipped` 为空(或仅是合规跳过的端点)

## 9. 常见问题排查

| 症状 | 原因 | 修法 |
|---|---|---|
| `FATAL: zt_acquire_token failed` | 密码错/账号锁 | 改 `~/.zentao.env`,重 source |
| `summary.bug_resolved` 与 `bugs_resolved.length` 不一致 | 不可能(脚本同步生成) | 检查脚本是否被改坏 |
| `bug_root_cause` 各 key 之和 ≠ `bug_resolved` | 同上 | 同上 |
| `done=0` 但你完成了任务 | view.sprints ∩ status=doing 为空 | 看 stdout `mySprints=N` trace,N=0 时让管理员加迭代 |
| `tasks_done[]` 缺某 task | finishedDate 不在本周或 finishedBy 不是 me | jq 过滤原始 JSON 的 finishedDate 字段确认 |
| `bugs_resolved[]` 缺某 bug | 该 product 未在 view.products,或 bug status=closed 但默认 list 漏(脚本已加 `?status=all` 兜底) | 检查 `view.products` 是否包含该产品 ID |
| display_path 缺父名,只有 `【T{id}】` | 父任务未在工作集且 `/tasks/{pid}` 调用失败 | 看 `_meta.skipped`,可能是 budget 或网络;手工跑 `zt_get /tasks/{pid}` 确认 |
| 跨年周(W01/W52)边界异常 | ISO 周算法 bug | 单测见 `references/scripts/collect-weekly.js` § ISO week math;9/9 已通过 |
