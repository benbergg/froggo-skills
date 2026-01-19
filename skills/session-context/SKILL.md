---
name: session-context
description: "手动/自动触发：当需要恢复历史会话上下文（如重启后恢复调试现场）、查找之前讨论过的方案时，使用 Claude Context 搜索会话历史"
---

# 会话上下文恢复规范

获取历史会话上下文时，使用 Claude Context 的会话搜索功能。

## 触发场景

- 重启 Claude Code 后需要恢复之前的工作上下文
- 调试问题时需要回顾之前的讨论
- 查找之前讨论过的设计方案或决策
- 用户说 "之前我们讨论过..." 但当前会话没有记录
- 需要了解某个问题的历史处理过程

## 执行流程

```
需要历史会话上下文
        ↓
检查会话是否已索引
    ↓           ↓
  已索引      未索引
    ↓           ↓
search_sessions  index_sessions
    ↓           ↓
返回相关会话   索引完成后搜索
        ↓
提取关键信息恢复上下文
```

## 搜索模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| vector | 语义相似度搜索（默认） | 模糊查找、概念搜索 |
| text | 关键词文本搜索 | 精确查找特定内容 |
| both | 混合搜索 | 不确定时使用 |

## 搜索范围

| scope | 说明 |
|-------|------|
| current | 当前项目的会话（默认） |
| all | 所有项目的会话 |

## 关键规则

1. **主动提示** - 检测到可能需要历史上下文时提醒用户
2. **scope 选择** - 默认 current 项目，跨项目用 all
3. **隐私意识** - 仅搜索必要信息，不过度暴露历史
4. **先索引再搜索** - 首次使用需要先索引会话

## 工具使用

### index_sessions

索引会话历史：

```
mcp__claude-context__index_sessions
  - scope: "current" 或 "all"
  - force: false（增量索引）或 true（重新索引）
```

### search_sessions

搜索会话：

```
mcp__claude-context__search_sessions
  - query: 搜索查询（字符串或数组）
  - mode: "vector" | "text" | "both"
  - scope: "current" | "all"
  - limit: 结果数量（默认 10）
```

## 示例

用户说："之前我们讨论过登录功能的实现方案，能帮我找一下吗？"

```
1. 检查并索引会话
   index_sessions(scope: "current")

2. 语义搜索
   search_sessions(
     query: "登录功能 实现方案 讨论",
     mode: "vector",
     scope: "current"
   )

3. 返回相关会话摘要，帮助用户恢复上下文
```

## 常见场景

### 重启后恢复工作

```
用户：我刚重启了 Claude Code，之前在调试一个 bug
操作：search_sessions(query: "调试 bug 错误", mode: "both")
```

### 查找历史决策

```
用户：为什么我们选择用 Redis 而不是 Memcached？
操作：search_sessions(query: "Redis Memcached 选择 决策", mode: "vector")
```
