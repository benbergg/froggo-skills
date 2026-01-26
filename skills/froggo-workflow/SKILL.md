---
name: froggo-workflow
description: "Use when starting development tasks - 开发任务、新功能、Bug修复、重构、需要技术调研或文档归档时"
---

# froggo-workflow 开发流程规范

## Overview

统一开发流程入口，确保：
1. **技术准确性** - 强制使用 context7/serena 查询最新文档和项目结构
2. **流程完整性** - 9 阶段标准流程，关键节点用户确认
3. **知识沉淀** - 每个阶段产出物自动归档到知识库

## When to Use

- 开发新功能
- 修复 Bug
- 重构代码
- 任何需要完整流程的开发任务

## 流程模式

根据启动参数选择模式：

| 模式 | 命令 | 阶段数 | 适用场景 |
|------|------|--------|----------|
| **完整模式** | `/froggo-workflow` | 9 阶段 | 新功能、大重构、复杂 Bug |
| **快速模式** | `/froggo-workflow quick` | 7 阶段 | 小修复、配置调整、文档更新 |

快速模式跳过阶段3设计评审和阶段7 Code Review，但**不跳过技术调研**。

---

## 流程阶段（9阶段）

```
① 需求分析 → ② 设计 → ③ 设计评审 → ④ 计划
                                         ↓
⑨ 文档归档 ← ⑧ 提交 ← ⑦ Code Review ← ⑥ 测试 ← ⑤ 开发
```

### 阶段1：需求分析

**调用 Skill：** `superpowers:brainstorming`

**执行内容：**
1. 与用户交互式澄清需求
2. 遇到技术问题时，按需调用技术调研（见下方检查清单）
3. 输出需求文档

**完成动作：** 立即调用 `doc-writer` 保存需求文档到 `01-Requirements/`

**产出物：** 需求文档 → `01-Requirements/yyyyMMdd-序号-{名称}.md`

### 阶段2：设计

**调用 Skill：** `superpowers:brainstorming`

**执行内容：**
1. 基于需求进行设计
2. 遇到技术问题时，按需调用技术调研
3. 输出设计文档

**完成动作：** 立即调用 `doc-writer` 保存设计文档到 `04-Designs/`

**产出物：** 设计文档 → `04-Designs/yyyyMMdd-{禅道ID}-{名称}.md`

### 阶段3：设计评审

**执行内容：**
1. 请用户审查设计文档
2. 收集评审意见
3. 如需修改，返回阶段2设计

**产出物：** 评审意见（附加到设计文档）

### 阶段4：计划

**调用 Skill：** `superpowers:writing-plans`

**执行内容：**
1. 基于设计文档创建开发计划
2. 分解任务，明确步骤

**完成动作：** 立即调用 `doc-writer` 保存计划文档到 `03-Plans/`

**产出物：** 计划文档 → `03-Plans/yyyyMMdd-{禅道ID}-{名称}.md`

### 阶段5：开发

**调用 Skill：** `superpowers:executing-plans`

**执行内容：**
1. 按计划执行开发
2. 可选使用 `superpowers:subagent-driven` 并行开发

**产出物：** 代码

### 阶段6：测试

**调用 Skill：** `superpowers:verification`

**执行内容：**
1. 运行测试验证
2. 如有失败，返回阶段5开发

**产出物：** 测试结果

### 阶段7：Code Review

**调用 Skill：** `superpowers:code-reviewer`

**执行内容：**
1. 代码审查
2. 如需修改，返回阶段5开发

**产出物：** Review 意见

### 阶段8：提交

**调用 Skill：** `git-commit`

**执行内容：**
1. 按规范提交代码
2. 格式：`<type>: <description> #<zentao_id>`

**产出物：** Git Commit

### 阶段9：文档归档

**调用 Skill：** `doc-writer`

**执行内容：**
1. 更新所有文档的 `status` 为"已完成"
2. 补充文档间的 wikilinks 双向关联
3. 添加提交记录（commit hash）到相关文档

**产出物：** 更新后的关联文档（状态+关联+提交记录）

---

## 技术调研检查清单

在阶段1、2，遇到以下情况时**必须**先进行调研：

| 触发条件 | 调用工具 | 示例 |
|----------|----------|------|
| 涉及外部库/框架 API | `lib-docs` (context7) | "hooks 怎么配置" → 查 Claude Code 文档 |
| 需要了解项目现有实现 | `serena` | "项目里有没有类似功能" → 分析项目结构 |
| 可能有历史需求/设计 | `doc-reader` | "之前做过类似的吗" → 搜索知识库 |

### lib-docs (context7) 使用规范

| 关键词类别 | 示例 | 对应 Context7 库 |
|-----------|------|-----------------|
| Claude Code | hooks, plugin, skill, agent | /anthropics/claude-code |
| React | useState, useEffect, component | /facebook/react |
| Vue | ref, reactive, computed | /vuejs/core |
| 其他框架 | 根据 package.json 识别 | 自动匹配 |

### serena 使用规范

| serena 工具 | 用途 |
|-------------|------|
| `get_symbols_overview` | 了解文件/模块的符号结构 |
| `find_symbol` | 查找特定函数/类的定义 |
| `find_referencing_symbols` | 了解符号的引用关系 |
| `list_dir` / `find_file` | 探索项目目录结构 |
| `search_for_pattern` | 搜索代码模式 |

---

## 阶段门禁（用户确认点）

每个阶段完成后，**必须**使用 `AskUserQuestion` 工具确认后才能进入下一阶段。

### 确认点1：需求分析 → 设计

需求文档完成后：
1. **先保存**：调用 `doc-writer` 保存需求文档到 `01-Requirements/`
2. **再确认**：询问用户

- header: "阶段确认"
- question: "需求文档已保存，是否进入设计阶段？"
- options:
  - label: "是，继续设计"
    description: "进入设计阶段"
  - label: "需要技术调研"
    description: "先调用 lib-docs/serena 进行调研"
  - label: "返回修改需求"
    description: "继续完善需求，稍后重新保存"

### 确认点2：设计 → 评审

设计文档完成后：
1. **先保存**：调用 `doc-writer` 保存设计文档到 `04-Designs/`
2. **再确认**：询问用户

- header: "阶段确认"
- question: "设计文档已保存，是否进入评审阶段？"
- options:
  - label: "是，进入评审"
    description: "进入设计评审阶段"
  - label: "返回修改设计"
    description: "继续完善设计，稍后重新保存"

### 确认点3：评审 → 计划

- header: "阶段确认"
- question: "设计评审完成，是否通过？"
- options:
  - label: "通过，继续"
    description: "进入计划阶段"
  - label: "需要修改"
    description: "返回设计阶段修改"

### 确认点4：计划 → 开发

计划文档完成后：
1. **先保存**：调用 `doc-writer` 保存计划文档到 `03-Plans/`
2. **再确认**：询问用户

- header: "阶段确认"
- question: "计划文档已保存，确认开始开发？"
- options:
  - label: "开始开发"
    description: "调用 executing-plans 开始"
  - label: "返回修改计划"
    description: "继续完善计划，稍后重新保存"

### 确认点5：开发 → 测试

- header: "阶段确认"
- question: "开发完成，进入测试阶段？"
- options:
  - label: "是，开始测试"
    description: "调用 verification 验证"
  - label: "继续开发"
    description: "还有未完成的开发任务"

### 确认点6：测试 → Code Review

- header: "阶段确认"
- question: "测试通过，进入 Code Review？"
- options:
  - label: "是，开始 Review"
    description: "调用 code-reviewer 审查"
  - label: "返回修复"
    description: "有测试未通过，返回开发"

### 确认点7：Code Review → 提交

- header: "阶段确认"
- question: "Review 完成，准备提交代码？"
- options:
  - label: "提交代码"
    description: "调用 git-commit 提交"
  - label: "返回修改"
    description: "有 Review 意见需要处理"

### 确认点8：提交 → 文档归档

- header: "阶段确认"
- question: "代码已提交，更新关联文档？"
- options:
  - label: "是，更新文档"
    description: "更新知识库文档关联"
  - label: "跳过归档"
    description: "本次不需要更新文档"

---

## 快速模式流程

快速模式跳过阶段3设计评审和阶段7 Code Review：

```
① 需求分析 → ② 设计 → ④ 计划 → ⑤ 开发 → ⑥ 测试 → ⑧ 提交 → ⑨ 文档归档
```

确认点减少为 6 个（跳过确认点3和确认点7）。

---

## 文档归档规范

### 各阶段产出物

| 阶段 | 产出物 | 保存位置 |
|------|--------|----------|
| 1. 需求分析 | 需求文档 | `01-Requirements/yyyyMMdd-序号-{名称}.md` |
| 2. 设计 | 设计文档 | `04-Designs/yyyyMMdd-{禅道ID}-{名称}.md` |
| 4. 计划 | 计划文档 | `03-Plans/yyyyMMdd-{禅道ID}-{名称}.md` |
| 6. 测试 | 测试报告 | `07-Tech/yyyyMMdd-{主题}-测试报告.md` |

### Wikilinks 关联

每个文档的 frontmatter 必须包含关联：

```yaml
---
created: 2025-01-26
project: xxx
related_requirement: "[[20250126-001-xxx需求]]"
related_design: "[[20250126-0000-xxx设计]]"
related_plan: "[[20250126-0000-xxx计划]]"
---
```

---

## Common Mistakes

| 错误 | 正确做法 |
|------|----------|
| 跳过技术调研直接开始设计 | 遇到不确定的技术问题时，先用 lib-docs/serena 调研 |
| 凭记忆写配置，不查文档 | 涉及第三方库/框架时，必须用 context7 查最新文档 |
| 不了解项目现有结构就写代码 | 用 serena 分析项目结构，了解现有实现 |
| 产出物未保存到知识库 | 每个阶段完成后调用 doc-writer 保存 |
| 文档间缺少 wikilinks | 使用 frontmatter 建立双向关联 |
| 跳过用户确认直接进入下一阶段 | 必须通过 AskUserQuestion 确认后才能继续 |
| 快速模式跳过技术调研 | 快速模式只跳过评审，不跳过调研 |
| 需求不明确就开始设计 | 在需求分析阶段充分澄清，不确定时问用户 |

---

## 核心原则

1. **不确定就调研** - 涉及外部库/框架/项目结构时，先查文档
2. **每个阶段都确认** - 用 AskUserQuestion 获得用户许可
3. **产出物必归档** - 调用 doc-writer 保存到知识库

---

## 依赖的 Skills/Tools

**必需：**
- `lib-docs` (context7) - 外部文档查询
- `serena` - 项目结构分析
- `doc-reader` - 知识库搜索
- `doc-writer` - 文档归档
- `git-commit` - 代码提交

**可选（superpowers）：**
- `superpowers:brainstorming` - 需求分析和设计
- `superpowers:writing-plans` - 编写计划
- `superpowers:executing-plans` - 执行计划
- `superpowers:verification` - 测试验证
- `superpowers:code-reviewer` - 代码审查
