# Local Verify

## dry-run

```bash
# 1. 加载凭据
set -a; source ~/.zentao.env; set +a

# 2. zentao-api 6 snippet
# (从 zentao-api/references/quickstart.md 整段 source)

# 3. 跑日报到 /tmp/(不写知识库)
ZENTAO_PRODUCTS=95 bash skills/daily-report/references/scripts/run.sh manual
```

输出:
- `/tmp/daily-${TODAY}-${pid}.json`(每产品中间数据)
- `/tmp/daily-${TODAY}.aggregated.json`(聚合)
- `/tmp/daily-${TODAY}.md`(渲染结果)
- `/tmp/daily-${TODAY}.summary.txt`(飞书摘要)

## diff weekly-report 交叉验证

```bash
# 当周 weekly-report
WK_NUM=$(date "+%G-W%V")
WEEKLY_FILE="$HOME/Knowledge-Library/05-Reports/weekly/${WK_NUM}.md"

# 当日 daily-report 解决/完成数 ≤ weekly-report 当周数
grep -E '今日(解决|完成)' /tmp/daily-${TODAY}.md
grep -E '本周(解决|完成)' "$WEEKLY_FILE"
# 手动核对:daily 数 ⊂ weekly 当日子集
```

## 进度算法独立测试

```bash
source skills/daily-report/references/scripts/progress.sh
calc_progress 1234 "$(cat skills/daily-report/tests/fixtures/progress-hours.json)" testing
# Expected: {"value":67,"source":"hours"}
```

## 限流模拟

```bash
# 在 retry.sh 加临时变量,模拟第 N 次调用返 429
DAILY_BACKOFF_OVERRIDE="0 0 0 0" bash skills/daily-report/tests/test-retry.sh
```

## 部署前 checklist(8 项)

- [ ] 所有单元测试通过(`for f in skills/daily-report/tests/test-*.sh; do bash $f || break; done`)
- [ ] dry-run 在产品 95 上跑通,输出 `/tmp/daily-${TODAY}.md`
- [ ] 人工对比禅道 UI 看板,偏差 < 10%
- [ ] mock fixture 覆盖完整(`stories/bugs/tasks/role-map/progress-*` 全在)
- [ ] `~/.zentao-roles.yaml` 已配置(unknown 比例 < 30%)
- [ ] `FEISHU_DAILY_WEBHOOK` 配置且通(可推一条测试消息)
- [ ] `plugin.json` 版本号 1.27.0
- [ ] CHANGELOG 记录 V1 新增
