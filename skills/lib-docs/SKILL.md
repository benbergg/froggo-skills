---
name: lib-docs
description: "自动触发：当需要查询任何编程库、框架或工具的文档、API 用法、配置选项时，必须使用 Context7 获取最新文档，禁止依赖记忆猜测"
---

# 库文档查询规范

查询编程库、框架或工具的官方文档时，必须使用 Context7 MCP 获取最新文档。

## 触发场景

- 查询库/框架的 API 用法（如 "React useState 怎么用"）
- 查询配置选项（如 "Vite 的 proxy 配置"）
- 查询最佳实践（如 "TypeScript 泛型最佳实践"）
- 确认某个方法/参数的正确写法
- 不确定某个 API 是否存在或用法是否正确

## 执行流程

```
需要查询库/框架文档
        ↓
调用 resolve-library-id 获取库 ID
        ↓
调用 query-docs 查询具体问题
        ↓
基于返回的文档回答用户
```

## 关键规则

1. **禁止猜测** - 不确定的 API 用法必须查询，不要凭记忆回答
2. **先 resolve 再 query** - 必须先调用 resolve-library-id 获取库 ID
3. **引用来源** - 回答时说明信息来自 Context7 文档
4. **最多 3 次调用** - 每个问题最多调用 3 次，找不到则用已有信息

## 工具使用

### resolve-library-id

获取 Context7 兼容的库 ID：

```
mcp__context7__resolve-library-id
  - libraryName: 库名称（如 "react", "vite"）
  - query: 用户的具体问题
```

### query-docs

查询文档内容：

```
mcp__context7__query-docs
  - libraryId: 从 resolve-library-id 获取的 ID
  - query: 具体问题描述
```

## 示例

用户问："React useEffect 的 cleanup 函数怎么写？"

```
1. resolve-library-id(libraryName: "react", query: "useEffect cleanup function")
   → 获取 libraryId: "/facebook/react"

2. query-docs(libraryId: "/facebook/react", query: "useEffect cleanup function examples")
   → 获取文档内容

3. 基于文档内容回答用户
```
