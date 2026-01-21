---
name: doc-reader
description: "Use when searching for requirements, designs, tasks, plans, or documents in Knowledge Library"
---

# 文档读取规范

## Overview

从知识库搜索和读取文档，支持按类型、项目、关键词、日期等多种条件查询。

## When to Use

- 查找需求、设计、任务、计划等文档
- 按项目或禅道 ID 查找相关文档
- 搜索包含特定关键词的文档
- 了解某个功能的完整上下文（批量读取）

## Quick Reference

**搜索路径（按优先级）：**

1. `~/workspace/Knowledge-Library/` — 个人知识库（优先）
2. 当前项目 `docs/` 目录
3. 当前项目根目录

**查询语法：**

| 语法 | 示例 | 说明 |
|------|------|------|
| `type:<类型>` | `type:design` | 按文档类型 |
| `project:<项目>` | `project:bytenew-llm` | 按项目筛选 |
| `zentao:<ID>` | `zentao:T1234` | 按禅道关联 |
| `status:<状态>` | `status:进行中` | 按状态筛选 |
| `date:<日期>` | `date:2025-01` | 按创建日期 |
| `<关键词>` | `登录功能` | 全文搜索 |

**类型可选值：**

| 类型 | 目录 |
|------|------|
| requirement | 01-Requirements/ |
| task | 02-Tasks/ |
| plan | 03-Plans/ |
| design | 04-Designs/ |
| weekly | 05-Reports/weekly/ |
| kpr | 05-Reports/KPR/ |
| tech | 07-Tech/ |

## 执行流程

```dot
digraph flow {
    rankdir=LR;
    node [shape=box];

    query [label="解析查询条件"];
    search [label="搜索文档"];
    list [label="显示结果列表"];
    read [label="读取选中文档"];

    query -> search -> list -> read;
}
```

## 输出格式

搜索结果显示：文件路径、标题、创建日期、项目、状态，然后让用户选择要查看的文档。

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 只搜索当前项目 | 优先搜索 Knowledge-Library |
| 忘记组合查询 | 支持多条件：`type:design project:xxx` |
| 只读取单个文档 | 相关文档可批量读取了解上下文 |

## 示例

```
/read-doc type:design project:bytenew-llm
/read-doc 登录 status:进行中
/read-doc zentao:T1234 type:plan
```
