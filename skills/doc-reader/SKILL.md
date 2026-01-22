---
name: doc-reader
description: "Use when searching/reading/finding documents - 搜索文档、查找文档、读取文档、查看文档、找文档、看看之前的、Knowledge Library、知识库、需求、设计、任务、计划、Obsidian、wikilink、frontmatter、关联文档、上下文"
---

# 文档读取规范

## Overview

从 Obsidian 知识库搜索和读取文档，支持 frontmatter 属性查询、wikilink 关联追踪、多条件组合搜索。

## When to Use

- 查找需求、设计、任务、计划等文档
- 按项目或禅道 ID 查找相关文档
- 追踪文档间的 wikilink 关联（如 `[[related_task]]`）
- 了解某个功能的完整上下文（批量读取关联文档）
- 按 frontmatter 属性筛选（status、project、tags 等）

## Quick Reference

### 搜索路径

| 优先级 | 路径 | 说明 |
|--------|------|------|
| 1 | `~/workspace/Knowledge-Library/` | 个人知识库（Obsidian vault） |
| 2 | 当前项目 `docs/` | 项目文档 |
| 3 | 当前项目根目录 | 项目相关文件 |

### 目录结构

| 类型 | 目录 | 命名格式 |
|------|------|----------|
| requirement | 01-Requirements/ | `yyyyMMdd-序号-需求名.md` |
| task | 02-Tasks/ | `yyyyMMdd-禅道ID-任务名.md` |
| plan | 03-Plans/ | `yyyyMMdd-禅道ID-功能.md` |
| design | 04-Designs/ | `yyyyMMdd-禅道ID-功能.md` |
| weekly | 05-Reports/weekly/ | `YYYY-WXX.md` |
| kpr | 05-Reports/KPR/ | `YYYY-QX-KPR.md` |
| tech | 07-Tech/ | `yyyyMMdd-主题-描述.md` |

### 查询语法

| 语法 | 示例 | 说明 |
|------|------|------|
| `type:<类型>` | `type:design` | 按目录类型 |
| `project:<项目>` | `project:bytenew-llm` | frontmatter 的 project 属性 |
| `zentao:<ID>` | `zentao:T1234` 或 `zentao:B48387` | 任务/Bug ID |
| `status:<状态>` | `status:进行中` | frontmatter 的 status 属性 |
| `tag:<标签>` | `tag:type/bug` | frontmatter 的 tags 数组 |
| `date:<日期>` | `date:2025-01` | 按创建日期（文件名前缀） |
| `<关键词>` | `登录功能` | 文件名或全文搜索 |

### Frontmatter 属性

知识库文档使用 YAML frontmatter，常见属性：

```yaml
---
created: 2026-01-20
updated: 2026-01-20
project: bytenew-llm  # 项目标识
status: 进行中        # 进行中 / 已完成 / 暂停
zentao_id: T1234      # 禅道任务/Bug ID
branch: feature/xxx   # Git 分支
tags:
  - type/bug
  - domain/llm
related_task: "[[20260120-T42015-任务名]]"  # wikilink 关联
---
```

## 执行策略

### 1. 单文档查询

已知文档名或禅道 ID 时，直接定位：

```bash
# 按禅道 ID 搜索
find ~/workspace/Knowledge-Library -name "*T42015*" -o -name "*B48387*"

# 按关键词搜索文件名
find ~/workspace/Knowledge-Library -name "*自定义中差评*"
```

### 2. 多条件组合查询

使用 grep 搜索 frontmatter 属性：

```bash
# 搜索特定项目的进行中任务
grep -rn "project: bytenew-llm" ~/workspace/Knowledge-Library/02-Tasks/ | \
  xargs -I{} dirname {} | xargs -I{} grep -l "status: 进行中" {}

# 搜索包含特定标签的文档
grep -rn "type/bug" ~/workspace/Knowledge-Library/
```

### 3. Wikilink 关联追踪

文档中的 `[[文档名]]` 是 Obsidian wikilink，用于关联文档：

```bash
# 提取文档中的 wikilink
grep -oE '\[\[[^\]]+\]\]' 文档.md

# 查找引用某文档的所有文档
grep -rn '\[\[20260120-T42015' ~/workspace/Knowledge-Library/
```

**关联追踪流程：**
1. 读取目标文档
2. 提取 frontmatter 中的 `related_task`、`related_design` 等字段
3. 提取正文中的 `[[...]]` wikilinks
4. 逐个读取关联文档，构建完整上下文

### 4. 上下文批量读取

理解一个功能时，应读取完整文档链：

```
需求 → 任务 → 设计 → 技术文档
01-Requirements → 02-Tasks → 04-Designs → 07-Tech
```

按禅道 ID 批量搜索：
```bash
find ~/workspace/Knowledge-Library -name "*T42015*" -type f
```

## 输出格式

搜索结果显示：
- 文件路径
- 标题（frontmatter 或 H1）
- 创建日期
- 项目（project 属性）
- 状态（status 属性）
- 关联文档数量

让用户选择要查看的文档，或一次性读取全部关联文档。

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 只搜索当前项目 | 优先搜索 Knowledge-Library |
| 忽略 wikilink 关联 | 追踪 `[[...]]` 读取关联文档 |
| 只读取单个文档 | 批量读取同一功能的需求/任务/设计 |
| 忽略 frontmatter | 利用 project/status/tags 精准筛选 |
| 关键词拼写错误 | 支持模糊搜索，多尝试不同关键词 |

## 示例

```
# 按类型搜索
type:design project:bytenew-llm

# 按禅道 ID 搜索（会找到所有关联文档）
zentao:T42015

# 按状态和项目组合
status:进行中 project:VOC

# 按标签搜索
tag:type/bug

# 关键词搜索
自定义中差评 type:design
```
