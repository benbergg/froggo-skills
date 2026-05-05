# Data Collection (D1-D5)

## D1 — 需求快照

API:`/products/{pid}/stories?status=all`(分页)

四态判定(按优先级,首匹配胜):

| 类别 | 判定 |
|---|---|
| ✅ today_done | `closedDate ≥ TODAY_START` 或 `finishedDate ≥ TODAY_START` |
| 早前已完成 | `status=closed` 或 `stage ∈ {closed, released}`(且不命中今日完成)— **排除** |
| ⚠️ unassigned | `stage=wait` 且 `assignedTo == null` 或 `""` |
| ⏸ idle | `stage=wait` 且 `assignedTo` 非空 |
| 🔄 in_progress | 其他 |

字段保留:`id, title, stage, status, assignedTo, openedBy, openedDate, closedDate, finishedDate, pri, product, plan`。

入口函数:`classify_stories(stories_array, today_start)`(`scripts/collect-stories.sh`)。

## D2 — 需求当日变化

对 in_progress + today_done 拉详情:`/stories/{sid}` → `.actions[]` filter `date >= TODAY_START`。

降级:N > 100 时只取列表字段判"今日新建/今日完成"。

## D3 — Bug 快照

API:`/products/{pid}/bugs?status=all`(分页,**必加 `?status=all`**)

状态分桶:

| 桶 | 判定 |
|---|---|
| 新增/未处理 | `status=active` 且 `confirmed=0` |
| 处理中 | `status=active` 且 `confirmed!=0` |
| 已解决待验 | `status=resolved` |
| 已关闭 | `status=closed` |

字段保留:`id, title, status, resolution, severity, pri, openedBy, assignedTo, resolvedBy, openedDate, resolvedDate, closedDate, confirmed`。

## D4 — Bug 当日变化

直接列表字段筛(无需详情):
- 新建:`openedDate >= TODAY_START`
- 解决:`resolvedDate >= TODAY_START`
- 关闭:`closedDate >= TODAY_START`

## D5 — 任务采集

链路:`product → projects → executions → tasks`

```bash
projects = zt_get /products/{pid}/projects
for projectId:
  executions = zt_get /projects/{projectId}/executions
  for eid:
    tasks = zt_paginate /executions/{eid}/tasks
    flat = [.tasks[]?] + [.tasks[]?.children[]?]   # 必递归
```

字段保留:`id, name, type, status, assignedTo, story, parent, deadline, estimate, consumed, left, finishedDate, closedDate`。

**范围内降级**:
1. 取 D1 范围(in_progress + today_done)的 story_id 集合
2. 过滤 task.story 在集合内
3. 范围内任务数 ≥ `DAILY_TASK_LIMIT` → `EXPAND_TASKS=false`,只列需求 + 任务计数

## API 调用预算与限流

- 预算 env `DAILY_API_BUDGET`(默认 600)
- 限流(429/503/"rate limit"):指数退避 1s/2s/4s/8s
- 单产品超时 `DAILY_PER_PRODUCT_TIMEOUT`(默认 300s)熔断
- V1 串行,不并发

## 中间 JSON Schema

详见设计文档 §4.8。每产品一份 `/tmp/daily-${TODAY}-${PID}.json`,聚合后 `/tmp/daily-${TODAY}.aggregated.json`。
