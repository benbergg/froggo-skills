---
name: lib-docs
description: "Use when querying API usage, configurations, or best practices for libraries/frameworks, or when unsure about correct syntax"
---

# 库文档查询规范

## Overview

查询编程库、框架或工具的文档时，必须使用 Context7 获取最新文档，**禁止凭记忆猜测 API 用法**。

## When to Use

- 查询 API 用法（如 "React useState 怎么用"）
- 查询配置选项（如 "Vite 的 proxy 配置"）
- 查询最佳实践（如 "TypeScript 泛型最佳实践"）
- 确认方法/参数的正确写法
- 不确定某个 API 是否存在或用法是否正确

## Quick Reference

| 步骤 | 工具 | 参数 |
|------|------|------|
| 1. 获取库 ID | `mcp__context7__resolve-library-id` | libraryName, query |
| 2. 查询文档 | `mcp__context7__query-docs` | libraryId, query |

**限制**：每个问题最多调用 3 次，找不到则用已有信息

## 执行流程

```dot
digraph flow {
    rankdir=LR;
    node [shape=box];

    start [label="查询需求"];
    resolve [label="resolve-library-id\n获取库 ID"];
    query [label="query-docs\n查询文档"];
    answer [label="基于文档回答\n(引用来源)"];

    start -> resolve -> query -> answer;
}
```

## 关键规则

1. **禁止猜测** - 不确定必须查询，不凭记忆回答
2. **先 resolve 再 query** - 必须先获取库 ID
3. **引用来源** - 回答时说明信息来自 Context7 文档

## 红旗清单

遇到以下想法时，**停止并查询文档**：

| 借口 | 正确做法 |
|------|----------|
| "这个 API 我很熟悉" | 仍然查询，API 可能有更新 |
| "应该是这样写的" | "应该" = 不确定 = 必须查询 |
| "查询太慢了" | 错误答案比慢更糟糕 |
| "文档里可能没有" | 先查询再说，Context7 覆盖广泛 |
| "这是基础知识" | 基础也会混淆，查询确认 |

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 直接回答 API 用法 | 先查询 Context7 再回答 |
| 跳过 resolve-library-id | 必须先获取库 ID |
| 不说明来源 | 明确说"根据 Context7 文档" |
| 调用超过 3 次 | 3 次内找不到就用已有信息 |

## 示例

用户："React useEffect cleanup 怎么写？"

```
1. resolve-library-id("react", "useEffect cleanup") → /facebook/react
2. query-docs("/facebook/react", "useEffect cleanup examples")
3. 基于文档回答，说明"根据 Context7 文档..."
```
