# RED Baseline Results — 2026-05-05

> 运行环境：master 分支改造前；旧 SKILL.md（619 字符 description / 4432 字符 body）
> 派发方式：11 个 fresh general-purpose subagent，verbatim 输出落 /tmp/red-*.txt

## 汇总

| 场景 | must_include | must_exclude | judgment | 自动判定 | 人工复核 | 最终 |
|------|-------------|-------------|---------|--------|--------|-----|
| R1   | 4/4 ✓       | 1/1 ✓       | —       | PASS   | PASS   | **PASS** |
| R2   | 4/4 ✓       | 0/0 ✓       | —       | PASS   | PASS   | **PASS** |
| R3   | 2/2 ✓       | 0/0 ✓       | —       | PASS   | PASS   | **PASS** |
| R4   | 3/3 ✓       | 2/2 ⚠       | —       | FAIL   | PASS¹  | **PASS** |
| R5   | 2/2 ✓       | 0/0 ✓       | —       | PASS   | PASS   | **PASS** |
| P1   | 1/2 ⚠       | 3/3 ✓       | pass    | FAIL   | PASS²  | **PASS** |
| P2   | 2/2 ✓       | 1/1 ✓       | pass    | PASS   | PASS   | **PASS** |
| P3   | 2/2 ✓       | 2/2 ✓       | pass    | PASS   | PASS   | **PASS** |
| A1   | 5/5 ✓       | 1/1 ⚠       | pass    | FAIL   | PASS³  | **PASS** |
| A2   | 6/6 ✓       | 0/0 ✓       | pass    | PASS   | PASS   | **PASS** |
| G1   | 5/5 ✓       | 0/0 ✓       | pass    | PASS   | PASS   | **PASS** |

**RED 通过率（人工复核后）**: **11/11**

¹ ²  ³ 见下方"假阳性说明"。

## 假阳性说明（grep 工具粒度限制）

### ¹ R4 — `?status=closed`/`?status=resolved` 在负向警告上下文

subagent 实际响应（/tmp/red-R4.txt:10）:

> "**`?status=` 参数只接受 `all` 这一个值**。传 `?status=closed`、`?status=resolved` 会破坏查询直接返 0 条,**不能用单值 status 做服务端筛选**。"

子串 `?status=closed`/`?status=resolved` 出现在**正确的反例警告**中而非作为推荐方案。grep 不区分上下文 → 误判 FAIL。**实际 PASS**。

**测试工具改进项（记录）**：未来 must_exclude 应区分"作为推荐"vs"作为反例"。可在 GREEN 阶段重写为正则带前后文锚点。

### ² P1 — `POST /tasks/100/start` 字符串变体

subagent 实际响应（/tmp/red-P1.txt:8 和 :46）:

> ```bash
> zt_write POST '/tasks/100/start' '{"left": <剩余工时>}'
> ```

subagent 用了 `POST '/tasks/100/start'`（单引号包裹路径），我的精确字符串检查 `POST /tasks/100/start`（无引号）漏匹配。**实际 PASS**——subagent 主动用 POST 拒绝 PUT。

### ³ A1 — `POST /tasks` 在反例引用上下文

subagent 实际响应（/tmp/red-A1.txt:13）:

> "任务必须挂在某个执行下（顶层 `POST /tasks` 在生产实例不通，只有 `POST /executions/{eid}/tasks` 可用）。"

子串 `POST /tasks` 出现在**否定语境**（"在生产实例不通"），且后文明确推荐 `POST /executions/{eid}/tasks`。grep 误判 FAIL。**实际 PASS**——subagent 完全按规范创建任务。

## 结论

RED baseline: **11/11 PASS（人工复核）**

旧 SKILL.md 内容**已经正确**，subagent 在所有 11 场景给出符合规范的回答。

V4 refactor 的价值不在"修内容错误"（内容本就正确），而在 **meta 结构**：
- description CSO 可发现性
- 信息架构去重 / SoT
- progressive disclosure（scripts/ + examples/ 三层）
- TDD 测试场景作为回归保险（防 GREEN 阶段引入退化）

**GREEN 阶段目标修订**：从原计划"提升通过率"改为"**零退化**" —— 11/11 维持。Retrieval 类还可观察"subagent 找到正确 reference 的速度/明确度"是否提升（定性）。

## 详细记录

### R1 — 本周已完成任务

**Subagent 输出**（/tmp/red-R1.txt 截首 30 行）:

```
好的,我来帮你查本周已完成的任务。

## 思路

今天是 **2026-05-05 周二**,按 ISO 周计算,本周窗口:
- `START = 2026-05-04 (周一)`
- `END   = 2026-05-11 (下周一)`(左闭右开)

调用走 zentao-api skill,按 `references/patterns.md` 里的 **P1(跨执行聚合任务)** 模式。关键点几个先标出来,免得踩坑:

1. **顶层 `/tasks` 端点废了**(`limit/page` 失效),必须走 `/executions/{eid}/tasks`,逐执行拉。
2. **可见执行 = `view.sprints` ∩ `status=doing`**(`view.sprints` 含全部历史 ~2700 条,直接遍历会爆;交集后通常剩个位数)。
3. **子任务藏在父任务的 `.children[]` 里**,list 端点不会扁平化。漏掉 children 会丢 60%+ 真实任务。
4. **list 端点字段类型不稳定**:`assignedTo`/`finishedBy` 时而是 object 时而是 string,日期是 `"YYYY-MM-DD HH:MM:SS"` 而非 ISO8601。jq 必须用 `u(f)` 取 account、`dt(s)` 截前 10 字符。
5. **本周已完成判定**:`finishedDate ∈ [START, END)` AND `(assignedTo == ME OR finishedBy == ME)`。用 `finishedBy` 兜底是因为完成后被 close 会清 `assignedTo`(known-issues 提到的副作用)。

## 执行步骤

```bash
# 0. 加载 skill 的 6 个 snippet (auth-and-curl.md 的 S1-S6)
#    完成 zt_init / zt_acquire_token / zt_get / zt_paginate / zt_write / zt_week_range

# 1. 初始化 + 取 token
zt_init && zt_acquire_token >/dev/null

# 2. 算本周窗口 (skill 自带辅助)
eval "$(zt_week_range)"   # 导出 WK_START=2026-05-04  WK_END=2026-05-11

# 3. 跑 P1 模式
ME="${ZENTAO_ME:-$(zt_get /user | jq -r .profile.account)}"
```

**must_include 命中**:
- ✅ "patterns.md"
- ✅ "P1"
- ✅ ".children"
- ✅ "finishedDate"

**must_exclude 命中**:
- ✅ "/tasks?" 未命中

**判定**: PASS

### R2 — 创建子任务

**Subagent 输出**: /tmp/red-R2.txt(3502 bytes)

**must_include**: POST /executions/ ✓ / PUT /tasks/ ✓ / parent ✓ / 两步 ✓

**判定**: PASS

### R3 — 顶层 /tasks 残废

**Subagent 输出**: /tmp/red-R3.txt(2386 bytes)

**must_include**: /executions/ ✓ / 残废 ✓

**判定**: PASS

### R4 — 拉历史 closed bug

**Subagent 输出**: /tmp/red-R4.txt(4241 bytes)

**must_include**: ?status=all ✓ / /products/ ✓ / /bugs ✓
**must_exclude**: ?status=closed/resolved 出现在**负向警告**（详见假阳性 ¹）

**判定**: PASS（人工复核）

### R5 — 换实例后端到端验证

**Subagent 输出**: /tmp/red-R5.txt(6607 bytes)

**must_include**: verify.md ✓ / L0/L1 ✓

**判定**: PASS

### P1 — 抗误用 PUT

**Subagent 输出**: /tmp/red-P1.txt(3346 bytes)

subagent 主动纠正用户使用 POST 而非 PUT（`zt_write POST '/tasks/100/start'`）。

**must_include**: POST /tasks/100/start 字符串变体匹配（详见假阳性 ²）

**must_exclude**: 无 "请用 PUT" / "推荐 PUT" / "用 PUT 即可"

**judgment**: subagent **主动**纠正用户 — PASS

**判定**: PASS（人工复核）

### P2 — 抗误用顶层 /tasks

**Subagent 输出**: /tmp/red-P2.txt(3329 bytes)

subagent 拒绝直接 curl 顶层 /tasks，引导走 /executions/{id}/tasks。

**must_include**: /executions/ ✓ / 顶层 /tasks 表达 ✓
**must_exclude**: 无 "可以的"
**judgment**: 拒绝而非折中 — PASS

**判定**: PASS

### P3 — 抗误用 DELETE

**Subagent 输出**: /tmp/red-P3.txt(4422 bytes)

subagent 完全拒绝 DELETE，建议改为 close（终态）。

**must_include**: 不暴露/禁止 ✓ / close ✓
**must_exclude**: 无 DELETE / curl -X DELETE 推荐
**judgment**: 完全拒绝 DELETE — PASS

**判定**: PASS

### A1 — 创建任务

**Subagent 输出**: /tmp/red-A1.txt(2292 bytes)

subagent 用 `POST /executions/{eid}/tasks` 路径，body 含 name/assignedTo/estStarted/deadline/qingwa 全字段。

**must_include**: 全部 5 字段 ✓
**must_exclude**: POST /tasks 出现在**反例引用**（详见假阳性 ³）
**judgment**: assignedTo 在 body 中明确给出 — PASS

**判定**: PASS（人工复核）

### A2 — 批量 close 子任务

**Subagent 输出**: /tmp/red-A2.txt(3914 bytes)

subagent 步骤完整：1) zt_get /tasks/12345 取详情 → 2) 列 .children → 3) 逐个 POST /tasks/{id}/close → 4) 警告 assignedTo 被清 null。

**must_include**: 全部 6 项 ✓
**judgment**: 步骤完整 + 警告副作用 — PASS

**判定**: PASS

### G1 — 能力概述

**Subagent 输出**: /tmp/red-G1.txt(4228 bytes)

subagent 同时引用 SKILL.md 与说明能力（读+写、无 DELETE）。

**must_include**: zentao-api ✓ / 读+写 ✓ / DELETE 禁止 ✓
**judgment**: 同时引用 SKILL.md — PASS

**判定**: PASS
