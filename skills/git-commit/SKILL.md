---
name: git-commit
description: "This skill should be used when committing code changes, executing commit steps in implementation plans, or when any workflow requires 'git commit'. 提交代码、git commit、代码提交、生成commit message、写提交信息、提交更改、执行计划中的commit步骤、实现完成后提交、开发流程提交"
---

# Git 提交规范

## Overview

所有代码提交必须遵循 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/) 国际标准，使用英文撰写，确保变更历史在国际化协作中清晰可读、可被工具解析。

## When to Use

- 执行 `git commit` 命令时
- 执行 `/commit` 命令时
- 代码变更后需要生成提交信息时
- **执行实现计划（implementation plan）中的 commit 步骤时**
- **使用 superpowers:executing-plans 或 superpowers:subagent-driven-development 完成任务后提交时**
- **任何开发工作流需要提交代码时**

## Quick Reference

**格式（Conventional Commits）：**

```
<type>[!]: <description>

[optional body]

[optional footer(s)]
```

**Type 速查（国际标准）：**

| Type | 说明 |
|------|------|
| feat | A new feature |
| fix | A bug fix |
| docs | Documentation only changes |
| style | Formatting, white-space, semicolons (no code change) |
| refactor | Code change that neither fixes a bug nor adds a feature |
| perf | Performance improvement |
| test | Adding or correcting tests |
| build | Build system or external dependency changes |
| ci | CI configuration files and scripts |
| chore | Other maintenance changes (tooling, repo housekeeping) |
| revert | Reverts a previous commit |

**Breaking Change：**

- 在 type 后追加 `!`：`feat!: drop Node 18 support`
- 或在 footer 中添加 `BREAKING CHANGE: <说明>`

## 规则

1. **type**：英文小写，从速查表中选择
2. **description**：
   - 英文撰写
   - 祈使句、动词原形开头（add/fix/update/remove，不用 `added`/`adds`）
   - 首字母小写
   - 结尾不加句号
3. **subject 长度**：首行 ≤ 72 字符
4. **body**（可选）：与 subject 之间空一行；解释 *what* 与 *why*，不解释 *how*
5. **footer**（可选）：用于 `BREAKING CHANGE:` 或关联 issue（如 `Closes #123`）
6. **禁止联合签名**：不添加 `Co-Authored-By`、`Signed-off-by` 等署名

## 示例

**单行提交：**

```
feat: add user points system
fix: correct points calculation precision
docs: update points API reference
chore: bump spring boot to 3.4.0
refactor: extract checkout flow into service
perf: cache product lookup results
```

**Breaking change：**

```
feat!: drop support for Node 18

BREAKING CHANGE: Node 20+ is now required.
```

**多行提交（复杂变更）：**

```
feat: add user points system

- Introduce points table schema
- Implement increment/decrement APIs
- Add query endpoint with pagination

Closes #123
```

## Common Mistakes

| 错误 | 正确 |
|------|------|
| `Feat: add feature` | `feat: add feature` (type 小写) |
| `feat: 添加登录功能` | `feat: add login` (英文描述) |
| `feat: Added login.` | `feat: add login` (祈使句、无句号、首字母小写) |
| `hotfix: bug fix` | `fix: <description>` (用标准 `fix`) |
| `feat: add login #T1234` | `feat: add login` (不再使用禅道号) |
| 超长描述导致换行 | subject ≤ 72 字符，详情写到 body |

## 红旗清单

遇到以下想法时，**停止并遵循规范**：

| 借口 | 正确做法 |
|------|----------|
| "中文描述更直观" | 强制英文描述 |
| "用 `hotfix` 更醒目" | 标准命名只有 `fix` |
| "稍后补全 commit message" | 现在就写完整 |
| "加个 Co-Authored-By 没关系" | 禁止联合署名 |
| "description 写长点更清楚" | subject ≤ 72 字符，详情用 body |
| "过去式更自然" | Conventional Commits 要求祈使句 |

## 与其他 Skill 协作

当使用以下 skill 时，如遇到提交代码步骤，**必须使用本 skill 生成 commit message**：

| Skill | 触发场景 |
|-------|----------|
| superpowers:writing-plans | 计划中包含的 commit 步骤 |
| superpowers:executing-plans | 执行计划时的提交操作 |
| superpowers:subagent-driven-development | 子代理完成任务后的提交 |
| superpowers:finishing-a-development-branch | 完成分支工作时的提交 |

**重要**：即使其他 skill 或计划文档中写了具体的 commit 命令格式，也必须使用本 skill 的规范覆盖，确保：

- 使用英文描述（祈使句、首字母小写、无句号）
- 遵循 Conventional Commits 标准 type
- 不使用禅道号或其他内部任务号
- 禁止 Co-Authored-By 签名
