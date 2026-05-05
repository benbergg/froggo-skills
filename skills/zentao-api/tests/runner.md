# zentao-api TDD Runner Protocol

## 派发 subagent

每个场景通过 Claude Code Agent tool 派发 fresh subagent：

```
Agent({
  description: "Test scenario <ID>",
  subagent_type: "general-purpose",
  prompt: <<<
    User prompt: "<verbatim scenario prompt from scenarios.md>"
    
    Show your reasoning steps and final answer.
    Do not actually execute API calls — just describe what you'd do
    (e.g. "I would call zt_write POST /executions/100/tasks ...").
  >>>
})
```

## RED 阶段

- **运行环境**: 改造前 master 分支（旧 SKILL.md / auth-and-curl.md / known-issues.md 路径）
- **结果输出**: tests/results-red.md
- **预期**: 多数 Retrieval 弱通过；部分 Pressure 通过

## GREEN 阶段

- **运行环境**: 阶段 1 + 阶段 2 已 merge 后的分支
- **结果输出**: tests/results-green.md
- **通过门禁**:
  - 通过率 ≥10/11（允许 1 边缘 Fail，须在 refactor-log.md 解释）
  - Pressure P1/P2/P3 必须 100% 通过
  - Retrieval R1-R5 中 ≥4 个 subagent 主动找到正确 reference

## REFACTOR 阶段

- 对每个 GREEN Fail 场景：
  1. 记录 verbatim 输出 + 失败的 must_include / must_exclude / judgment
  2. 在对应 reference 文件加显式反驳条目（针对该 rationalization）
  3. 重跑该场景至通过
  4. 写 refactor-log.md 记录每轮迭代

## 结果文件格式

每场景一节，固定模板：

```markdown
## <ID> — <名称>

**派发时间**: 2026-05-05 HH:MM:SS

**Subagent 输出**（verbatim，截首 100 行）:

<output as code block>

**must_include 命中**:
- ✅ "patterns.md"
- ✅ "P1"
- ❌ ".children" — MISS
- ✅ "finishedDate"

**must_exclude 命中**:
- ✅ "/tasks?" 未命中（OK）

**判定**: FAIL（缺 .children 关键字）

**Rationalization 模式**（若 Fail）: subagent 用了 "递归子数组" 表达，没用 ".children"
```
