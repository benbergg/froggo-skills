---
name: zentao-sync
description: "从禅道同步任务/Bug 创建 Obsidian 文档"
arguments: "<任务ID>"
skill: zentao-sync
---

# /zentao-sync 命令

从禅道同步任务或 Bug，自动创建 Obsidian 任务文档。

## 用法

```
/zentao-sync <任务ID>
```

## 参数说明

| 参数 | 格式 | 说明 |
|------|------|------|
| 任务ID | `T1234` | 禅道任务，T 开头 + 数字 |
| BugID | `B5678` | 禅道 Bug，B 开头 + 数字 |

## 示例

```
/zentao-sync T1234    — 同步任务 T1234
/zentao-sync B5678    — 同步 Bug B5678
```

---

**执行**：调用 `zentao-sync` skill 处理
