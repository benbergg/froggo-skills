---
name: git-commit
description: "This skill should be used when committing code changes, executing commit steps in implementation plans, or when any workflow requires 'git commit'. 提交代码、git commit、代码提交、生成commit message、写提交信息、提交更改、执行计划中的commit步骤、实现完成后提交、开发流程提交"
---

# Git 提交规范

## Overview

所有代码提交遵循 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/) 国际标准。`type` 使用英文标准类型（工具解析依赖），`description` 与 `body` 推荐使用中文撰写，简洁清晰地说明变更，让变更历史易读、可被工具解析。

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

**Type 速查（国际标准，保持英文）：**

| Type | 说明 |
|------|------|
| feat | 新功能 |
| fix | 修复 bug |
| docs | 仅文档变更 |
| style | 格式调整（空白、分号等，不影响代码逻辑） |
| refactor | 既不修 bug 也不加功能的代码重构 |
| perf | 性能优化 |
| test | 新增或修正测试 |
| build | 构建系统或外部依赖变更 |
| ci | CI 配置文件与脚本 |
| chore | 其他维护性变更（工具链、仓库杂务） |
| revert | 回滚某次提交 |

**Breaking Change：**

- 在 type 后追加 `!`：`feat!: 移除 Node 18 支持`
- 或在 footer 中添加 `BREAKING CHANGE: <说明>`

## 规则

1. **type**：英文小写，从速查表中选择（标准要求，不中文化）
2. **description**：
   - **推荐中文撰写**（允许英文，尤其代码标识符、专有名词，如 `fix: 修复 NullPointerException`）
   - 动词开头：添加 / 修复 / 更新 / 删除 / 重构……（用英文时遵循祈使句原形 add/fix/update）
   - 简洁，**结尾不加句号**
3. **subject 长度**：首行简短（中文 ≤ 50 字，英文 ≤ 72 字符）
4. **body**（可选）：与 subject 之间空一行；解释 *what* 与 *why*，不解释 *how*；推荐中文
5. **footer**（可选）：用于 `BREAKING CHANGE:` 或关联 issue（如 `Closes #123`）；关键字保持英文，说明文字可中文
6. **禁止联合签名**：不添加 `Co-Authored-By`、`Signed-off-by` 等署名

## 示例

**单行提交：**

```
feat: 添加用户积分系统
fix: 修正积分计算精度
docs: 更新积分 API 文档
chore: 升级 spring boot 到 3.4.0
refactor: 抽取下单流程为独立 service
perf: 缓存商品查询结果
fix: 修复 NullPointerException
```

**Breaking change：**

```
feat!: 移除 Node 18 支持

BREAKING CHANGE: 现在要求 Node 20+。
```

**多行提交（复杂变更）：**

```
feat: 添加用户积分系统

- 引入积分表结构
- 实现增减积分接口
- 添加分页查询端点

Closes #123
```

## Common Mistakes

| 错误 | 正确 |
|------|------|
| `Feat: 添加功能` | `feat: 添加功能`（type 小写） |
| `新功能: 添加登录` | `feat: 添加登录`（type 保持英文标准） |
| `feat: 添加了登录功能。` | `feat: 添加登录功能`（动词开头、结尾无句号） |
| `hotfix: 修 bug` | `fix: <描述>`（用标准 `fix`） |
| 超长描述导致换行 | subject 简短，详情写到 body |

## 红旗清单

遇到以下想法时，**停止并遵循规范**：

| 借口 | 正确做法 |
|------|----------|
| "type 用中文更直观" | type 保持英文标准，工具解析依赖它 |
| "用 `hotfix` 更醒目" | 标准命名只有 `fix` |
| "稍后补全 commit message" | 现在就写完整 |
| "加个 Co-Authored-By 没关系" | 禁止联合署名 |
| "description 写长点更清楚" | subject 简短，详情用 body |
| "结尾加个句号更完整" | description 结尾不加句号 |

## 与其他 Skill 协作

当使用以下 skill 时，如遇到提交代码步骤，**必须使用本 skill 生成 commit message**：

| Skill | 触发场景 |
|-------|----------|
| superpowers:writing-plans | 计划中包含的 commit 步骤 |
| superpowers:executing-plans | 执行计划时的提交操作 |
| superpowers:subagent-driven-development | 子代理完成任务后的提交 |
| superpowers:finishing-a-development-branch | 完成分支工作时的提交 |

**重要**：即使其他 skill 或计划文档中写了具体的 commit 命令格式，也必须使用本 skill 的规范覆盖，确保：

- 使用中文描述（动词开头、结尾无句号；允许保留英文标识符）
- 遵循 Conventional Commits 标准 type（英文小写）
- 不使用内部任务号
- 禁止 Co-Authored-By 签名
