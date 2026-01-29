---
name: git-commit
description: "This skill should be used when committing code changes, executing commit steps in implementation plans, or when any workflow requires 'git commit'. 提交代码、git commit、代码提交、生成commit message、写提交信息、提交更改、执行计划中的commit步骤、实现完成后提交、开发流程提交"
---

# Git 提交规范

## Overview

所有代码提交必须遵循 Conventional Commits 格式并关联禅道任务号，确保变更历史可追溯、可检索。

## When to Use

- 执行 `git commit` 命令时
- 执行 `/commit` 命令时
- 代码变更后需要生成提交信息时
- **执行实现计划（implementation plan）中的 commit 步骤时**
- **使用 superpowers:executing-plans 或 superpowers:subagent-driven-development 完成任务后提交时**
- **任何开发工作流需要提交代码时**

## Quick Reference

**格式：**
```
<type>: <description> #<zentao_id>
```

**Type 速查：**

| Type | 说明 | 禅道关联 |
|------|------|----------|
| feat | 新功能 | #T1234 |
| hotfix | 修复 bug | #B5678 |
| docs | 文档变更 | #0000 |
| style | 代码格式 | #0000 |
| refactor | 重构 | #T1234 |
| perf | 性能优化 | #T1234 |
| test | 测试相关 | #T1234 |
| chore | 构建/工具/依赖 | #0000 |
| revert | 回滚 | #T1234 |

**禅道 ID 格式：**
- 任务：`#T1234`
- Bug：`#B5678`
- 无关联：`#0000`

## 规则

1. **type**：英文小写，从速查表中选择
2. **description**：中文描述，简洁说明变更内容
3. **zentao_id**：必须包含，无关联时使用 `#0000`
4. **长度**：整行不超过 72 字符
5. **禁止联合签名**：不添加 `Co-Authored-By`

## 示例

**单行提交：**
```
feat: 添加用户积分系统 #T1234
hotfix: 修复积分计算精度问题 #B5678
docs: 更新积分API文档 #T1234
chore: 升级Spring Boot版本 #0000
```

**多行提交（复杂变更）：**
```
feat: 添加用户积分系统 #T1234

- 新增积分表结构
- 实现积分增减 API
- 添加积分查询接口
```

## Common Mistakes

| 错误 | 正确 |
|------|------|
| `Feat: 添加功能` | `feat: 添加功能` (type 小写) |
| `feat: add login` | `feat: 添加登录功能` (中文描述) |
| `feat: 添加功能` | `feat: 添加功能 #T1234` (缺少禅道号) |
| `fix: 修复bug` | `hotfix: 修复bug` (bug 修复用 hotfix) |
| 超长描述导致换行 | 保持整行 ≤72 字符 |

## 红旗清单

遇到以下想法时，**停止并遵循规范**：

| 借口 | 正确做法 |
|------|----------|
| "这次改动太小不需要禅道号" | 使用 `#0000` |
| "稍后补全 commit message" | 现在就写完整 |
| "英文描述更专业" | 规范要求中文描述 |
| "这个不算 bug 用 fix 就行" | bug 修复统一用 `hotfix` |
| "加个 Co-Authored-By 没关系" | 禁止联合签名 |
| "description 写长点更清楚" | 控制在 72 字符内，详情用多行格式 |

## 与其他 Skill 协作

当使用以下 skill 时，如遇到提交代码步骤，**必须使用本 skill 生成 commit message**：

| Skill | 触发场景 |
|-------|----------|
| superpowers:writing-plans | 计划中包含的 commit 步骤 |
| superpowers:executing-plans | 执行计划时的提交操作 |
| superpowers:subagent-driven-development | 子代理完成任务后的提交 |
| superpowers:finishing-a-development-branch | 完成分支工作时的提交 |

**重要**：即使其他 skill 或计划文档中写了具体的 commit 命令格式，也必须使用本 skill 的规范覆盖，确保：
- 使用中文描述
- 包含禅道任务号
- 禁止 Co-Authored-By 签名
