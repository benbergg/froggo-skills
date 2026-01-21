---
name: doc-writer
description: "Use when creating requirements, designs, tasks, plans, weekly reports, KPR, or technical notes"
---

# 文档写入规范

## Overview

创建文档时自动输出到知识库的规范目录，使用统一的命名格式和 frontmatter 结构。

## When to Use

- brainstorming 完成后输出设计文档
- 创建需求文档、开发计划、技术笔记
- 创建周报或 KPR
- 创建 API 文档
- 创建任务文档

## Quick Reference

**默认配置：**

| 配置项 | 默认值 |
|--------|--------|
| doc_root | `~/workspace/Knowledge-Library/` |
| templates_dir | `~/workspace/Knowledge-Library/06-Templates/` |

**文档类型映射：**

| 类型 | 目录 | 命名格式 |
|------|------|----------|
| 需求文档 | 01-Requirements/ | `yyyyMMdd-序号-名称.md` |
| 任务文档 | 02-Tasks/ | `yyyyMMdd-禅道ID-名称.md` |
| 开发计划 | 03-Plans/ | `yyyyMMdd-禅道ID-名称.md` |
| 设计文档 | 04-Designs/ | `yyyyMMdd-禅道ID-名称.md` |
| 周报 | 05-Reports/weekly/ | `YYYY-WXX.md` |
| KPR | 05-Reports/KPR/ | `YYYY-QX-KPR.md` |
| 技术笔记 | 07-Tech/ | `yyyyMMdd-主题-描述.md` |

**命名说明：**
- `yyyyMMdd`: 日期如 `20250118`
- `序号`: 三位数如 `001`
- `禅道ID`: `T1234`/`B5678`，无任务用 `0000`

## Frontmatter 规范

**基础属性（所有文档）：**

```yaml
---
created: 2025-01-18
updated: 2025-01-18
project: bytenew-llm  # 项目名称
status: 进行中        # 进行中/已完成/暂停
tags: []
---
```

**任务文档额外属性：**

```yaml
zentao_id: T1234
branch: feature/xxx
published: 未发布     # 未发布/已发布
deployed: dev        # dev/testc/pre/pro/oly/pg/ysld
```

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 文件名不含日期 | 必须以 `yyyyMMdd` 开头 |
| 缺少 frontmatter | 所有文档必须有完整 frontmatter |
| 禅道 ID 格式错误 | 任务用 `T1234`，Bug 用 `B5678` |
| 输出到错误目录 | 按类型输出到对应目录 |

## 配置覆盖

用户可在项目 `CLAUDE.md` 中覆盖默认配置：

```markdown
## froggo-skills 配置

- doc_root: /custom/path/to/docs
- templates_dir: /custom/path/to/templates
```
