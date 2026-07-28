# 取数策略探测脚本

一次性只读脚本,用来**用实测数据验证关于禅道取数方式的假设**,而不是靠推理。
每个假设砍错的代价都是静默丢数据,所以任何"这个查询是多余的"结论都必须先
在这里跑出证据。

跑法(需要 `ZENTAO_BASE_URL` 与 `~/.cache/zentao/token.json`):

```bash
set -a; . ~/.openclaw/.env; set +a
node probe-strategy.js       # 三腿独有贡献 / 分页早退 / stories 列表字段
node probe-story-tasks.js    # story.tasks 能否替代 exec 慢端点
node probe-task-detail.js    # /tasks/{id} 是否可用 / 过滤参数是否生效
```

token 过期(全部 401)时先刷新:

```bash
bash -c 'source ~/.openclaw/skills/zentao-api/scripts/zt-functions.sh && zt_init && zt_acquire_token'
```

## 2026-07-28 首轮结论

| 假设 | 结论 | 证据 |
|---|---|---|
| 三腿有冗余,可砍 | **证伪** | `lastEditedDate` 单腿只覆盖 29/36、25/26、35/37;`finishedDate` 腿在 exec 2028 独有 6 条(禅道更新 `finishedDate` 时不更新 `lastEditedDate`) |
| `/products/*/stories` 列表带 `executions` | **证伪** | 列表无该字段,16 次 `/stories/{id}` 省不掉 |
| `story.tasks` 可替代 exec 端点 | **部分成立** | id 集合与 exec 三腿并集完全一致(8/8 story 漏=0),但每条只有 5 个字段,缺 `deriveTask` 需要的全部日期字段 |
| `/tasks/{id}` 可用 | **成立** | 74-76 字段齐全,0.4-2.0s 点查(对比 exec 端点 3.9-59.3s) |
| exec 端点过滤参数可用 | **证伪** | `story=` / `assignedTo=` / `lastEditedDate=>` 全部被静默忽略(total 不变);`status=doing` 生效但 `rows≠total`,仍是 raw-window quirk |
| loose task 需要三腿 | **证伪** | 单腿 `lastEditedDate` 覆盖 5/5,另两腿独有均为 0 |

关键推论:exec 端点的职责若缩小为"发现 loose task",慢端点调用可从 9 次降到 1 次;
story-attached 任务改走 `story.tasks`(id 清单) + `/tasks/{id}`(完整字段),把关键
路径从高方差慢查询(3.9-59.3s)换成低方差点查(0.4-2.0s)。

**但这些都还只是候选**。上述数据是单日、白天时段、8 个 story 的样本;
`story.tasks` 是否永远完整、loose 单腿是否天天够用,必须靠影子验证连续比对
结果集才能定论。先看 `analyze-runs.js` 的多日数据,再谈换。
