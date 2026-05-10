# JSON Schema · `/tmp/weekly-{WK_NUM}.json`

> 由 [`scripts/collect-weekly.js`](scripts/collect-weekly.js) 输出。AI 撰写时必须按此 schema 读取。
> 与 [`exp-compass-daily/references/data-schema.md`](../../exp-compass-daily/references/data-schema.md) 同款"脚本只做 Zentao→标准 JSON,AI 看 JSON 写报告"理念。

## 顶层结构

```jsonc
{
  "week": "2026-W19",
  "wk_start": "2026-05-04T00:00:00+08:00",
  "wk_end":   "2026-05-11T00:00:00+08:00",
  "next_s":   "2026-05-11T00:00:00+08:00",
  "next_e":   "2026-05-18T00:00:00+08:00",
  "me":       "qingwa",                      // ZENTAO_ME 或自动从 /user.profile.account 拉

  "summary":         { ... },                // ground truth,关键数据行必须直接用
  "bug_root_cause":  { ... },                // ground truth,Bug 根因 4 行表必须直接用
  "tasks_done":      [ ... ],                // R1 完成分支
  "tasks_progress":  [ ... ],                // R1 进行分支
  "tasks_next_week": [ ... ],                // R4 下周待开展
  "bugs_resolved":   [ ... ],                // R2(?status=all)
  "bugs_active":     [ ... ],                // R3(active 快照)

  "_meta": { ... }
}
```

## `summary`(ground truth)

```jsonc
{
  "task_done":     5,    // tasks_done.length
  "task_progress": 3,    // tasks_progress.length
  "bug_resolved":  6,    // bugs_resolved.length
  "bug_active":    4,    // bugs_active.length
  "next_planned":  7     // tasks_next_week.length
}
```

> AI 写"本周关键数据行"时严禁自己重数,必须直接读这 5 个字段。

## `bug_root_cause`(ground truth,4 行表)

```jsonc
{
  "代码缺陷":   4,    // type ∈ {codeerror}
  "配置问题":   1,    // type ∈ {config, install}
  "需求缺失":   0,    // type ∈ {designdefect}
  "非缺陷类":   1     // type ∈ {others, standard, performance, security, automation}
}
```

| zentao type | 周报分类 |
|---|---|
| `codeerror` | 代码缺陷 |
| `config`, `install` | 配置问题 |
| `designdefect` | 需求缺失 |
| `others`, `standard`, `performance`, `security`, `automation`, 其他 | 非缺陷类 |

> 4 个 key 之和必须 == `bugs_resolved.length`。LLM 写表时直接用此对象,不再自己分桶。

## `tasks_done[]` / `tasks_progress[]`

```jsonc
{
  "id": 43849,
  "name": "后端",
  "parent_id": 43820,                            // 0 = 自身是根任务,-1 = sentinel(自身是父),> 0 = 子任务
  "parent_name": "618大促VOC评价优化",            // 仅 parent_id > 0 时非 null
  "display_path": "【T43820】618大促VOC评价优化/后端",  // 已拼好,LLM 直接用
  "status": "done",
  "status_cn": "已完成",
  "execution": 12345,                            // 所属执行 ID
  "deadline": "2026-04-30",                      // 无 deadline 时 null
  "finishedDate": "2026-04-28",                  // tasks_progress 可能为 null
  "lastEditedDate": "2026-04-28",
  "assignedTo": "qingwa",                        // realname 优先,fallback account
  "finishedBy": "qingwa",                        // tasks_progress 可能为空
  "wk_role": "完成"                              // "完成" | "进行"
}
```

**展示约定**:
- `display_path` 已经按 `data-collection.md §任务格式` 规则拼好:
  - 子任务(`parent_id > 0`):`【T{parent_id}】{parent_name}/{name}`
  - 根任务(`parent_id == 0` 或 `-1`):`【T{id}】{name}`
- 父子去重:已在 collect 内消化(若 `tasks_done ∪ tasks_progress` 中某 id 出现在其他项的 `parent_id`,该项被剔除)
- LLM 渲染时按 `wk_role` 分组(完成/进行)或合并展示(状态在行尾 `【已完成/进行中】`),由 SKILL.md 模板段决定

## `tasks_next_week[]`

```jsonc
{
  "id": 43919,
  "name": "数据源配置",
  "parent_id": 43902,
  "parent_name": "中差评跟踪处理",
  "display_path": "【T43902】中差评跟踪处理/数据源配置",
  "status": "wait",
  "status_cn": "未开始",
  "deadline": "2026-05-15",
  "pri": 2,
  "assignedTo": "qingwa"
}
```

**筛选条件**:`assignedTo == me && status ∈ {wait, doing} && deadline ∈ [next_s, next_e)`。

## `bugs_resolved[]` / `bugs_active[]`

```jsonc
{
  "id": 51837,
  "title_raw": "POS-001 [PROD] /api/v1/order 报 NPE,trace_id=abc123",  // 原始 title,LLM 改写为可读中文
  "type": "codeerror",
  "type_cn": "代码缺陷",                                                // 4 类映射后中文
  "severity": 2,
  "pri": 3,
  "status": "resolved",
  "status_cn": "已解决待验",
  "resolution": "fixed",                                                // bugs_active 为 null
  "openedDate": "2026-05-05",
  "openedBy": "lihua",
  "resolvedDate": "2026-05-07",                                         // bugs_active 为 null
  "resolvedBy": "qingwa",                                               // bugs_active 为 null
  "assignedTo": "qingwa",
  "productID": 95
}
```

**两种集合差异**:
- `bugs_resolved`:`resolvedBy == me && resolvedDate ∈ [wk_start, wk_end)`,采集时**必须加 `?status=all`**(否则 closed bug 静默漏)
- `bugs_active`:`assignedTo == me && status == "active"`,采集时**不加 `?status=all`**(默认已只返活跃)

> LLM 渲染时把 `title_raw` 改写为可读中文(去技术黑话、去命令、去路径、保留业务语义,长度 ≤ 40 字),输出形如 `B51837 POS 下单接口空指针异常`。

## `_meta`

```jsonc
{
  "api_calls": 87,
  "duration_ms": 124530,
  "skipped": [],                              // {path, page, reason}[] 失败页记录
  "budget_exceeded": false,
  "wall_clock_early_exit": false,
  "size_kb": 12.4
}
```

## 历史回归基线(2026-05-04 实测,V1 时代数据)

V2 采集应 ≥ V1 实测(V1 已发现真实周报手填遗漏):

| 周 | 真实任务 | V1 实测 | V2 期望 | 真实 Bug | V1 实测 | V2 期望 |
|---|---|---|---|---|---|---|
| W15 | 7 | 8 | ≥ 8 | 5 | 4 | ≥ 4 |
| W16 | 5 | 5 ✓ | ≥ 5 | 5 | 5 ✓ | ≥ 5 |
| W17 | 5 | 8 | ≥ 8 | 3 | 3 ✓ | ≥ 3 |
| W18 | 0 | 4 | ≥ 4 | 0 | 6 | ≥ 6 |

## 关键陷阱(V1 实测踩坑)

1. **`/executions/{id}/tasks` 子任务藏在 `.children[]`**:V2 `flattenChildren()` 已递归扁平化。
2. **`/products/{id}/bugs` 默认隐式 `status != closed`**:`bugs_resolved` 必须 `?status=all`,`bugs_active` 不加(自然只返活跃)。
3. **`.parent == -1` 是 sentinel(自身是父)**:不要回查父,V2 内部 `parent_id == -1` 时 `parent_name = null`、`display_path` 走根任务格式。
4. **list 端点 `assignedTo`/`finishedBy` 父对象是 object、子对象是 string**:V2 `pickName()` 兼容两者。
5. **PUT 任务/Bug action 静默 no-op**:本 skill 仅 GET,无影响;详见 [`zentao-api/troubleshooting.md §11`](../../zentao-api/troubleshooting.md)。
