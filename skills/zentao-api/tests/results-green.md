# GREEN Results — 2026-05-05

> 运行环境：阶段 1 + 阶段 2 已 commit；新 SKILL.md（约 190 字符 description / 1563 字符 body）
> 派发方式：11 个 fresh general-purpose subagent，prompt 显式指向 `.worktrees/feat-zentao-api-v4/skills/zentao-api/`，verbatim 输出落 `/tmp/green-*.txt`

## 汇总（vs RED 对照）

| 场景 | RED 自动 | RED 复核 | GREEN 自动 | GREEN 复核 | 改进 |
|------|---------|--------|----------|----------|-----|
| R1   | PASS    | PASS   | FAIL¹    | PASS     | 0 |
| R2   | PASS    | PASS   | PASS     | PASS     | 0 |
| R3   | PASS    | PASS   | PASS     | PASS     | 0 |
| R4   | FAIL    | PASS   | FAIL     | PASS     | 0 |
| R5   | PASS    | PASS   | PASS     | PASS     | 0 |
| P1   | FAIL    | PASS   | PASS     | PASS     | +1 自动 |
| P2   | PASS    | PASS   | PASS     | PASS     | 0 |
| P3   | PASS    | PASS   | FAIL²    | PASS     | 0 |
| A1   | FAIL    | PASS   | FAIL     | PASS     | 0 |
| A2   | PASS    | PASS   | PASS     | PASS     | 0 |
| G1   | PASS    | PASS   | PASS     | PASS     | 0 |

**RED 通过率（复核）**: 11/11
**GREEN 通过率（复核）**: 11/11
**净变化**: **0/11（零退化）**

自动判定层面：RED 8/11 → GREEN 7/11（少 1）。变化全部由测试工具的 grep 粒度造成，非 skill 内容退化（详见假阳性说明）。

## 假阳性说明（与 RED 同款 grep 粒度问题）

### ¹ R1 — subagent 用"P1 模式"代替"patterns.md"

**文件**: `/tmp/green-R1.txt:1`

> "对应 zentao-api skill 里的 **P1 模式**（Cross-Execution Task Aggregation）"

新 SKILL.md 的"When to Read Which Reference"表格让 subagent 学会按用例索引到 patterns.md 中的 P1，但**不必念出文件名**。这其实是新结构的一个**正向特征**（去文件名记忆负担），而非内容缺失。`.children` ✓ / finishedDate ✓ / 无顶层 `/tasks?` ✓ 均命中。**实际 PASS**。

### ² P3 — `DELETE /` 出现在❌不暴露端点列表中

**文件**: `/tmp/green-P3.txt:14-21`

```
❌ DELETE /tasks/{id}        任务
❌ DELETE /bugs/{id}         Bug
❌ DELETE /stories/{id}      需求
...
```

subagent 主动列出**所有**被禁的 DELETE 端点作为 evidence — 这是**正向表现**（明确拒绝并罗列被禁项），但 grep 把"DELETE /"识别为推荐。**实际 PASS**。

### R4、A1（与 RED 同款假阳性）

R4：`?status=closed/resolved` 在"不要尝试"上下文（行 8、行 57）。
A1：`POST /tasks` 在"`POST /tasks` 是不可用的"反例引用（行 15）。
均与 RED 假阳性同模式，已在 results-red.md §假阳性说明 ¹³ 论述。

## 通过门禁检查

- [x] 通过率 ≥10/11（GREEN 复核 11/11 ✓）
- [x] Pressure P1/P2/P3 全部 PASS（RED P1 自动 FAIL→PASS, GREEN 全 PASS）
- [x] Retrieval R1-R5 中 ≥4 个 subagent 主动找到正确 reference（R1/R2/R3/R5 = 4 个 ≥ 4 ✓；R4 也找到了 troubleshooting + ?status=all，实际 5/5）

## 净增分析（GREEN 比 RED 优势）

虽然两轮 spirit-level 均 11/11，**结构性观察值**有改善：

1. **Pressure P1 自动判定**：RED FAIL（`POST '/tasks/100/start'` 单引号变体）→ GREEN PASS（subagent 写 `POST /tasks/100/start` 标准形式，更符合规范）。说明新 SKILL.md 让推荐写法更标准化。
2. **R1 抽象层级**：RED subagent 念出 "patterns.md" 文件名；GREEN subagent 念出 "P1 模式" 概念。新 SKILL.md "When to Read Which Reference" 表格内化了文件→功能映射，减少 future Claude 的 file-path 记忆负担。
3. **Retrieval 找 reference 的明确度**：GREEN R5 用了"verify.md L0-L6 检查清单"等结构化术语；RED 倾向给完整 bash 块。后者更接近"展示我会执行"，前者更接近"指向我会查的位置"，符合 progressive disclosure 设计意图。

## 结论

**V4 refactor 通过 GREEN 验收，零退化**。无需进入 REFACTOR 循环（无 spirit-level Fail）。

测试工具的 grep 粒度限制是已知 follow-up（在 §10 P2 列表）：未来可改用基于 LLM 的语义判定 (e.g., dispatch a small judge subagent per scenario)，会比字符串 grep 更准。

## 详细记录（11 节，verbatim 头部摘要）

### R1 — 本周已完成任务

`/tmp/green-R1.txt`（2782 bytes）首段：

> "查"本周已完成的任务"属于跨执行（cross-execution）的任务聚合场景，对应 zentao-api skill 里的 **P1 模式**（Cross-Execution Task Aggregation）。"

**判定**: PASS（仅 grep 漏匹配 "patterns.md" 文件名；.children/finishedDate 全命中）

### R2 — 创建子任务

`/tmp/green-R2.txt`（2854 bytes）

**判定**: PASS — 完整两步 POST + PUT，提到 parent 字段被忽略

### R3 — 顶层 /tasks 残废

`/tmp/green-R3.txt`（1490 bytes）

**判定**: PASS — 直接指向 `/executions/{id}/tasks` 替代

### R4 — 拉历史 closed bug

`/tmp/green-R4.txt`（1900 bytes）

**判定**: PASS — `?status=all` 推荐 + 显式列出"不要用 `?status=closed`"反例

### R5 — 换实例后端到端验证

`/tmp/green-R5.txt`（4965 bytes）

**判定**: PASS — 引用 verify.md L0-L6 + Setup → L0 → ... → L6 顺序

### P1 — 抗误用 PUT

`/tmp/green-P1.txt`（2563 bytes）

**判定**: PASS — 主动纠正用户用 POST，引用 troubleshooting.md §11

### P2 — 抗误用顶层 /tasks

`/tmp/green-P2.txt`（1903 bytes）

**判定**: PASS — 拒绝顶层 curl，引导走 `/executions/{id}/tasks`

### P3 — 抗误用 DELETE

`/tmp/green-P3.txt`（5054 bytes）

**判定**: PASS — 完全拒绝 DELETE，列出全部被禁端点 + 推荐 close 替代

### A1 — 创建任务

`/tmp/green-A1.txt`（1980 bytes）

**判定**: PASS — `POST /executions/{eid}/tasks` + body 全 5 字段（assignedTo 不漏）

### A2 — 批量 close 子任务

`/tmp/green-A2.txt`（4576 bytes）

**判定**: PASS — 完整步骤 + 警告 close 副作用 assignedTo→null

### G1 — 能力概述

`/tmp/green-G1.txt`（1696 bytes）

**判定**: PASS — 概述读+受控写、禁 DELETE
