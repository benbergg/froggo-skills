---
name: read-doc
description: "从知识库搜索和读取文档"
arguments: "[查询条件]"
---

# /read-doc 命令

从知识库搜索和读取文档。

## 用法

```
/read-doc [查询条件]
```

## 查询方式

| 方式 | 示例 | 说明 |
|------|------|------|
| 按类型 | `/read-doc type:design` | 列出所有设计文档 |
| 按项目 | `/read-doc project:bytenew-llm` | 列出指定项目文档 |
| 按关键词 | `/read-doc 登录功能` | 搜索包含关键词的文档 |
| 按日期 | `/read-doc date:2025-01` | 列出指定月份创建的文档 |
| 按禅道ID | `/read-doc zentao:T1234` | 查找关联禅道任务的文档 |
| 按状态 | `/read-doc status:进行中` | 列出指定状态的文档 |

## 类型可选值

- `requirement` — 需求文档
- `task` — 任务文档
- `plan` — 开发计划
- `design` — 设计文档
- `weekly` — 周报
- `kpr` — KPR考核
- `tech` — 技术笔记

## 组合查询

```
/read-doc type:design project:bytenew-llm
/read-doc 登录 status:进行中
/read-doc zentao:T1234 type:plan
```

## 执行流程

1. 解析查询条件
2. 在知识库中搜索匹配的文档
3. 显示搜索结果列表（路径、标题、创建日期、状态）
4. 用户选择后读取完整内容
