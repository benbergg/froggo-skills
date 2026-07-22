# JSON Schema · `/tmp/exp-compass-{DATE}.json`

> 由 [`scripts/collect.js`](scripts/collect.js) 输出。AI 撰写时必须按此 schema 读取。
> 设计文档:[[20260507-体验罗盘日报-V2-设计文档]] § 4.3-4.4

## 顶层结构

```jsonc
{
  "date": "2026-05-07",
  "today_start": "2026-05-07T00:00:00+08:00",
  "product": { "id": 95, "name": "VOC" },
  "summary":      { ... },   // ground truth,概览表必须直接用
  "stories":      [ ... ],
  "loose_tasks":  [ ... ],
  "bugs":         [ ... ],
  "_meta":        { ... }
}
```

## `summary`(概览表 ground truth)

```jsonc
{
  "story": { "in_progress": 8, "active": 5, "stale": 3, "today_new": 3, "today_done": 5, "todo": 2 },
  "task":  { "in_progress": 17, "today_new": 14, "today_done": 21, "todo": 3 },
  "bug":   { "in_progress": 6, "today_new": 8, "today_done": 9, "todo": 5 }
}
```

| 字段 | 算法 |
|---|---|
| `story.in_progress` | `count(stage ∈ {developing, developed, tested})`(== active + stale,兼容保留) |
| `story.active` | **V4** `count(stage ∈ 进行中 && is_active)`,概览需求行渲染 `{active} (另滞留 {stale})` |
| `story.stale` | **V4** `count(stage ∈ 进行中 && !is_active)` |
| `story.today_new` | `count(is_today_opened)` |
| `story.today_done` | `count(is_today_done)` |
| `story.todo` | `count(stage ∈ {wait, planned, projected, draft})` |
| `task.in_progress` | `count(status == doing)` over **`stories[].tasks ∪ loose_tasks`** |
| `task.today_new` | `count(is_today_created)` 同上范围 |
| `task.today_done` | `count(is_today_finished && !is_aggregate_parent)` 同上范围 |
| `task.todo` | `count(status ∈ {wait, pause, blocked})` 同上范围 |
| `bug.in_progress` | **V4 重映射** `count(status == active)`(修复中;V3 曾是 resolved,列语义与需求/任务行相反被纠正) |
| `bug.today_new` | `count(is_today_opened)` |
| `bug.today_done` | `count(is_today_closed)` |
| `bug.todo` | **V4 重映射** `count(status == resolved)`(已解决待验证;概览表下须配 `ℹ️ BUG 行口径` 脚注) |

> **task 计数范围注释**:概览表是产品全景视图,task 4 列覆盖 JSON 中所有出现的 task(无论其所属 story 是否在"进行中"维度)。这与"需求推进"段仅显示 `stage∈{developing,developed,tested}` 不矛盾——前者宏观,后者微观。

## `stories[]`(三类混合,用 `stage` 区分)

```jsonc
{
  "id": 21241,
  "title": "评价情感优化针对宝洁环境隔离",
  "stage": "developing",
  "stage_cn": "研发中",
  "progress_pct": 100,           // 整数 0-100
  "progress_source": "工时",      // "工时" | "任务"(未完成任务缺工时时降级为任务计数) | "阶段"(无任务时回退)
  "openedBy": "鹿扬",             // 真实姓名优先,缺则 account
  "openedDate": "2026-04-20T09:00:00Z",
  "closedBy": null,
  "closedDate": null,
  "is_today_opened": false,
  "is_today_done": false,          // V4 拓宽:closed→closedDate 当天;released/verified→lastEditedDate 当天近似
  "is_active": true,               // V4:developing 恒 true;developed/tested 需「当日任务动态 ∨ 未完成任务 ∨ 逾期」;其余 false
  "last_activity_date": "2026-06-18T10:00:00Z",  // V4:max(tasks[].finishedDate ∪ tasks[].openedDate ∪ story.openedDate)
  "stale_days": 33,                // V4:date − last_activity_date 的整天数,滞留行 `(滞N天)` 用
  "is_today_tested": false,        // V4:stage=tested && 存在 type=test 且 is_today_finished 的任务("今日测试完毕"段)
  "tasks": [/* see tasks[] schema */]
}
```

**`stories[]` 包含三类**(撰写时按 stage 过滤):
1. **进行中**:`stage ∈ {developing, developed, tested}` → 进入"需求推进"段
2. **待处理**:`stage ∈ {wait, planned, projected, draft}` → 计入 summary.todo,不显示详情
3. **今日完成**:`stage ∈ {closed, released, verified} && is_today_done=true` → 进入"完成的需求"段

## `tasks[]`(出现在 `stories[].tasks` 与 `loose_tasks`)

```jsonc
{
  "id": 43911,
  "name": "评价情感优化针对宝洁环境隔离",
  "type": "devel",                // devel/test/design/affair/discuss/normal 等
  "storyID": 21241,                // 0 表示 loose task(未挂在任何 story 下)
  "parent": -1,                    // -1 表示顶层;>0 表示父 task id
  "status": "doing",
  "status_cn": "进行中",
  "assignedTo": "虹猫",
  "finishedBy": null,
  "openedBy": "qingwa",
  "display_handler": "虹猫",        // 派生:status∈{done,closed} ? finishedBy : assignedTo
  "deadline": "2026-05-10",        // null 表示无截止
  "is_overdue": false,             // 派生:deadline && deadline < today && status not in {done,closed}
  "overdue_days": 0,               // V4:is_overdue ? (date − deadline) 整天数 : 0
  "is_normal": true,               // !is_overdue
  "consumed": 8,                   // 工时(小时)
  "left": 0,
  "is_today_created": false,
  "is_today_finished": false,
  "is_aggregate_parent": false,    // 派生:该 task 是否至少有一个 today-finished 的 child(父任务的"完成"由子推动,渲染"完成任务"段时跳过)
  "openedDate": "...",
  "finishedDate": null
}
```

**注意**:
- `display_handler` 已根据 status 自动选好,渲染时直接用,**不要再判断**
- `is_normal` / `is_overdue` 已派生,自检 C5 直接对照
- 父任务的 children 已被扁平化为独立 task 记录(`parent` 字段保留关系)
- `is_aggregate_parent=true` 的 task 在"完成任务"段必须跳过,避免父+子重复列出(用户原话:"如果有子任务,就不要再写主任务了")

## `loose_tasks[]`

未挂在任何范围内 story 下,但**今日 created 或 finished** 的散任务。同 tasks[] schema。用于"今日产出"段的"完成任务"和"新增任务"列表。

## `bugs[]`

```jsonc
{
  "id": 53188,
  "title": "...",
  "display_title": "...",            // V4:去开头【…】前缀(客服日期戳)、trim、超 40 字截断加 …;渲染一律用它
  "status": "resolved",
  "status_cn": "已解决待验",         // active→待处理 / resolved→已解决待验 / closed→已关闭
  "severity": 3,
  "openedBy": "bug录入机器人",
  "openedDate": "2026-05-07T08:00:00Z",
  "resolvedBy": "huanghu",
  "resolvedDate": "2026-05-07T11:00:00Z",
  "closedBy": null,
  "closedDate": null,
  "assignedTo": "huanghu",
  "display_handlers": ["huanghu"],   // 派生:resolvedBy + closedBy 去重(顺序保留),空数组表示无人处理。V4 渲染改用 [修@resolvedBy 验@closedBy] 角色拆显,此数组保留兼容。
  "display_reporter": "黄虎",         // V4:openedBy 为机器人账号且有 assignedTo 时 → "{assignedTo}·机器人录入",否则 openedBy("新增 Bug"段用)
  "resolved_age_days": 0,            // V4:status=resolved ? (date − resolvedDate) 整天数 : 0(存量风险·待验收超期,阈值 >3 天)
  "is_today_opened": true,
  "is_today_resolved": true,
  "is_today_closed": false
}
```

**裁剪规则**(由 collect.js 完成,AI 不需再过滤):
- 保留 `status ∈ {active, resolved}`(常规 in-scope)
- 保留任意 `is_today_*=true` 的(包括 closed today)
- 历史 closed/postponed 不进 JSON

## `_meta`(诊断信息,AI 撰写时不展示给用户)

```jsonc
{
  "api_calls": 103,
  "duration_ms": 49291,
  "skipped": [],
  "budget_exceeded": false,
  "size_kb": 46.1,
  "degraded": false                // true 表示 JSON > 80KB 触发了 task 裁剪
}
```

`degraded=true` 时 stories[].tasks 仅保留:status=doing/wait/pause/blocked、is_today_*、is_overdue 的 task。其余 task 被丢弃以控制体积。

## 派生字段计算速查

| 字段 | 算法 |
|---|---|
| `stage_cn` | `{wait/planned/projected/draft → 未开始, developing → 研发中, developed → 研发完毕, tested → 测试完毕, released → 已发布, verified → 已验收, closed → 已完成}` |
| `status_cn` | `{wait → 未开始, doing → 进行中, done → 已完成, pause → 暂停, blocked → 阻塞, cancel → 取消, closed → 已关闭}` |
| `progress_pct` | 三级口径(2026-07-22 修复):**工时**=`round(Σconsumed/(Σconsumed+Σleft)*100)`,仅当所有未完成 leaf 都有工时数据(否则未填预估的任务对分母隐形,S22290 实证 5 任务 1 完成算出 100%);**任务**=`round(done_leaf/total_leaf*100)`(工时不可信时降级);**阶段**=无任务时估值 `{wait:0, projected:20, developing:50, developed:80, tested:90, closed:100}` |
| `display_handler`(task) | `["done","closed"].includes(status) ? finishedBy : assignedTo` |
| `display_handlers`(bug,数组) | `[resolvedBy, closedBy]` 去重,空字符串/null 跳过;空数组表示无人处理 |
| `is_overdue` | `deadline && deadline < today && !["done","closed"].includes(status)` |
| `is_today_*` | 字段日期 `startsWith(date)`(`openedDate.startsWith("2026-05-07")` 等) |
| `overdue_days`(task,V4) | `is_overdue ? max(0, floor((date − deadline)/86400s)) : 0` |
| `resolved_age_days`(bug,V4) | `status=resolved ? max(0, floor((date − resolvedDate)/86400s)) : 0` |
| `display_title`(bug,V4) | 去开头连续 `【…】` 前缀 → trim → 超 40 字(码点)截断加 `…` |
| `display_reporter`(bug,V4) | `ROBOT_ACCOUNTS.includes(openedBy) && assignedTo ? "{assignedTo}·机器人录入" : openedBy` |
| `is_active`(story,V4) | `developing → true;developed/tested → tasks.some(is_today_* ∨ status∈{doing,wait,pause,blocked} ∨ is_overdue);其余 → false` |
| `last_activity_date`(story,V4) | `max(tasks[].finishedDate ∪ tasks[].openedDate ∪ story.openedDate)` |
| `stale_days`(story,V4) | `max(0, floor((date − last_activity_date)/86400s))` |
| `is_today_tested`(story,V4) | `stage=tested && tasks.some(type=test && is_today_finished)` |

### account → realname 映射(V2 实测后补丁)

禅道 API 返回 person 字段类型不一致:有时是 `{realname, account}` 对象,有时是裸字符串 account。collect.js 启动时拉一次 `/users?limit=500` 建 `Map<account, realname>`,`pickName` 收到字符串时查表换中文真名(查不到则保留原 string,兼容陌生 account)。所有 `openedBy/assignedTo/finishedBy/closedBy/resolvedBy` 字段均经此处理。
