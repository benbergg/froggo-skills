---
name: code-search
description: "自动触发：当需要在代码库中搜索功能实现、查找函数/类/模块、探索代码结构时，优先使用 Claude Context 语义搜索"
---

# 代码语义搜索规范

在代码库中搜索代码实现时，优先使用 Claude Context 的语义搜索（search_code）。

## 触发场景

- 搜索某个功能的实现位置（如 "用户登录逻辑在哪"）
- 查找某个概念相关的代码（如 "权限校验相关代码"）
- 探索代码库结构（如 "API 路由是怎么组织的"）
- 查找相似实现（如 "有没有类似的表单验证"）
- 理解不熟悉的代码库

## 执行流程

```
需要搜索代码
        ↓
检查代码库是否已索引
    ↓           ↓
  已索引      未索引
    ↓           ↓
search_code   index_codebase
    ↓           ↓
返回结果    索引完成后 search_code
```

## 与 Grep 的区别

| 场景 | 使用工具 |
|------|----------|
| 精确查找字符串/符号名 | Grep |
| 语义搜索、概念查找 | search_code |
| 探索不熟悉的代码库 | search_code |
| 查找函数调用位置 | Grep |
| 查找功能实现思路 | search_code |

## 关键规则

1. **语义优先** - 模糊/概念性搜索用 search_code
2. **自动索引** - 未索引时先执行 index_codebase
3. **结合使用** - 必要时 search_code + Grep 配合
4. **路径必须绝对** - 所有路径参数必须使用绝对路径

## 工具使用

### index_codebase

索引代码库（首次搜索前需要）：

```
mcp__claude-context__index_codebase
  - path: 代码库绝对路径
  - splitter: "ast"（推荐，语法感知）
```

### search_code

语义搜索代码：

```
mcp__claude-context__search_code
  - path: 代码库绝对路径
  - query: 自然语言查询
  - limit: 结果数量（默认 10）
  - extensionFilter: 可选，文件扩展名过滤
```

### get_indexing_status

检查索引状态：

```
mcp__claude-context__get_indexing_status
  - path: 代码库绝对路径
```

## 示例

用户问："用户认证的逻辑在哪里？"

```
1. 检查索引状态
   get_indexing_status(path: "/Users/lg/workspace/project")

2. 如未索引，先索引
   index_codebase(path: "/Users/lg/workspace/project", splitter: "ast")

3. 语义搜索
   search_code(path: "/Users/lg/workspace/project", query: "用户认证逻辑 登录验证")

4. 基于搜索结果定位代码，用 Read 工具读取详情
```
