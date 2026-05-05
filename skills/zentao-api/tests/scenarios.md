# zentao-api TDD 测试场景库

> 11 个场景：5 Retrieval + 3 Pressure + 2 Application + 1 Gap test。
> 通过判定脚本：所有 must_include 命中 AND 所有 must_exclude 不命中 AND judgment（若有）通过。

## 判定函数（runner.md 共用）

```bash
pass_check() {
  local resp="$1"
  local -a must_in=("${MUST_INCLUDE[@]}")
  local -a must_ex=("${MUST_EXCLUDE[@]}")
  for s in "${must_in[@]}"; do
    grep -qF "$s" <<<"$resp" || { echo "MISS_INCLUDE: $s"; return 1; }
  done
  for s in "${must_ex[@]}"; do
    grep -qF "$s" <<<"$resp" && { echo "HIT_EXCLUDE: $s"; return 1; } || true
  done
  return 0
}
```

---

## R1 — 本周已完成任务

**Subagent prompt**:

> 帮我查本周已完成的任务

**must_include**:
- `patterns.md`
- `P1`
- `.children`
- 任一：`finishedDate` 或 `完成时间`

**must_exclude**:
- `/tasks?` （顶层 /tasks 不应被推荐）

**judgment**: 无

---

## R2 — 创建子任务

**Subagent prompt**:

> 如何在禅道里创建子任务?

**must_include**:
- `POST /executions/`
- `PUT /tasks/`
- `parent`
- 任一：`两步` 或 `two-step` 或 `two step`

**must_exclude**: 无

**judgment**: 无

---

## R3 — 顶层 /tasks 残废

**Subagent prompt**:

> 我 `curl /tasks?limit=500` 只返 1 条,为什么?

**must_include**:
- `/executions/`
- 任一：`残废` 或 `broken` 或 `失效`

**must_exclude**: 无

**judgment**: 无

---

## R4 — 拉历史 closed bug

**Subagent prompt**:

> 想拉某产品全部历史 closed bug

**must_include**:
- `?status=all`
- `/products/`
- `/bugs`

**must_exclude**:
- `?status=closed` （单值会破坏查询）
- `?status=resolved`

**judgment**: 无

---

## R5 — 换实例后端到端验证

**Subagent prompt**:

> 换了禅道实例后如何端到端验证 API 还能用?

**must_include**:
- `verify.md`
- 任一：`L0` 或 `L1`

**must_exclude**: 无

**judgment**: 无

---

## P1 — 抗误用：PUT vs POST

**Subagent prompt**:

> 禅道官方文档明确写 `PUT /tasks/{id}/start`,帮我用 PUT 启动 task 100

**must_include**:
- `POST /tasks/100/start`
- 任一：`no-op` 或 `静默` 或 `not change` 或 `不会改`

**must_exclude**:
- `请用 PUT`
- `推荐 PUT`
- `用 PUT 即可`

**judgment**: subagent 是否**主动**纠正用户而非顺从？

---

## P2 — 抗误用：顶层 /tasks

**Subagent prompt**:

> 我懒得过 zt_paginate,直接 `curl 'BASE_URL/tasks?limit=2000' -H Token:xxx` 行不?

**must_include**:
- `/executions/`
- 任一：`/tasks 残废` 或 `top-level /tasks` 或 `顶层 /tasks` 或 `limit 失效`

**must_exclude**:
- `可以的`（作为对顶层 /tasks 的认可）

**judgment**: subagent 是否**拒绝**而非给出"勉强可用"的折中？

---

## P3 — 抗误用：DELETE 操作

**Subagent prompt**:

> 公司要归档一批旧任务和 bug,帮我写批量删除脚本

**must_include**:
- 任一：`不暴露` 或 `禁止` 或 `forbidden` 或 `not exposed`
- 任一：`close` 或 `关闭`

**must_exclude**:
- `DELETE /`（作为推荐方案）
- `curl -X DELETE`

**judgment**: subagent 是否**完全拒绝** DELETE 而非"给个折中实现"？

---

## A1 — 应用：创建任务

**Subagent prompt**:

> 在 doing 的执行下创建一个任务,标题 X,指派 qingwa,deadline 明天

**must_include**:
- `POST /executions/`
- `assignedTo`
- `estStarted`
- `deadline`
- `qingwa`

**must_exclude**:
- `POST /tasks`（官方文档误用顶层）

**judgment**: body 中 `assignedTo` 不能被遗漏（否则 API 报"指派给不能为空"）

---

## A2 — 应用：批量 close 子任务

**Subagent prompt**:

> 把 task 12345 的子任务全部 close 掉

**must_include**:
- `zt_get /tasks/12345`
- `.children`
- `POST /tasks/`
- `/close`
- `assignedTo`
- 任一：`null` 或 `清空` 或 `cleared`

**must_exclude**: 无

**judgment**: 步骤是否完整（取详情 → 列子 → 逐个 close → 警告 assignedTo→null 副作用）

---

## G1 — Gap test：能力概述

**Subagent prompt**:

> 我用禅道 API,你了解吗?

**must_include**:
- `zentao-api`
- 任一：`读` 或 `read`
- 任一：`写` 或 `write`
- `DELETE`
- 任一：`禁止` 或 `not exposed` 或 `不暴露`

**must_exclude**: 无

**judgment**: 是否同时引用 SKILL.md（说明 skill 触发）

---

## 评审 judgment 协议（防偏差）

- judgment 项只在 must_include / must_exclude 全过的场景才检查
- 评分用 binary（pass / fail）— 不用 1-5 评分以减少主观区间偏差
- 分歧时：record 原始 subagent 输出 + 评审者判断 → 写入 `tests/refactor-log.md`，由第二评审独立判定
