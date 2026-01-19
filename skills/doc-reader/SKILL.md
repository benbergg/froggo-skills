---
name: doc-reader
description: "自动触发：当需要查找需求文档、设计文档、任务文档、开发计划时自动从知识库搜索；手动触发：通过 /read-doc 命令搜索"
---

# 文档读取规范

当用户需要查找和读取文档时，请遵循以下规范。

## 搜索路径

按优先级顺序搜索以下位置：

1. `~/workspace/Knowledge-Library/` — 个人知识库（优先）
2. 当前项目 `docs/` 目录 — 项目文档
3. 当前项目根目录 — README 等

## 搜索策略

支持以下查询方式：

| 查询方式 | 语法 | 示例 | 说明 |
|----------|------|------|------|
| 按类型 | `type:<类型>` | `type:design` | 搜索指定类型文档 |
| 按项目 | `project:<项目名>` | `project:bytenew-llm` | 按 frontmatter 项目筛选 |
| 按关键词 | `<关键词>` | `登录功能` | 全文搜索 |
| 按日期 | `date:<日期>` | `date:2025-01` | 按创建日期筛选 |
| 按禅道ID | `zentao:<ID>` | `zentao:T1234` | 按禅道任务关联查找 |
| 按状态 | `status:<状态>` | `status:进行中` | 按文档状态筛选 |

### 类型可选值

| 类型值 | 对应目录 |
|--------|----------|
| `requirement` | `01-Requirements/` |
| `task` | `02-Tasks/` |
| `plan` | `03-Plans/` |
| `design` | `04-Designs/` |
| `weekly` | `05-Reports/weekly/` |
| `kpr` | `05-Reports/KPR/` |
| `tech` | `07-Tech/` |

## 输出格式

### 搜索结果列表

找到文档后，显示结果列表：

```
找到 3 个相关文档：

1. 04-Designs/20250118-T1234-用户积分系统.md
   - 标题：用户积分系统 - 技术设计
   - 创建：2025-01-18
   - 项目：bytenew-llm
   - 状态：进行中

2. 03-Plans/20250118-T1234-用户积分系统.md
   - 标题：用户积分系统 - 开发计划
   - 创建：2025-01-18
   - 项目：bytenew-llm
   - 状态：已完成

3. 01-Requirements/20250115-001-积分系统需求.md
   - 标题：积分系统需求文档
   - 创建：2025-01-15
   - 项目：bytenew-llm
   - 状态：已完成

请选择要查看的文档（输入序号）：
```

### 读取文档

用户选择后，读取并显示完整文档内容。

### 批量读取

支持一次读取多个相关文档，用于了解完整上下文。

## 组合查询

支持多条件组合：

```
/read-doc type:design project:bytenew-llm
/read-doc 登录 status:进行中
/read-doc zentao:T1234 type:plan
```
