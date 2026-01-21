---
name: git-commit
description: "Use when committing code changes - 提交代码、git commit、代码提交、生成commit message、写提交信息、提交更改"
---

# Git 提交规范

## Overview

所有代码提交必须遵循 Conventional Commits 格式并关联禅道任务号，确保变更历史可追溯、可检索。

## When to Use

- 执行 `git commit` 命令时
- 执行 `/commit` 命令时
- 代码变更后需要生成提交信息时

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
