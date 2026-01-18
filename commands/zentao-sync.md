---
name: zentao-sync
description: "从禅道同步任务/Bug 创建 Obsidian 文档"
arguments: "<任务ID>"
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

## 环境变量配置

配置以下环境变量可实现自动登录：

```bash
export ZENTAO_USER="your_username"
export ZENTAO_PASSWORD="your_password"
```

未配置时将打开浏览器，需手动登录后继续。

## 执行流程

1. 解析任务 ID（T1234 → 任务，B5678 → Bug）
2. 检查环境变量，决定认证方式
3. 使用 playwright-skill 访问禅道页面
4. 抓取任务详情（标题、类型、优先级、描述等）
5. 调用 doc-writer 创建任务文档到 `02-Tasks/`

## 输出

成功后创建文档：

```
~/workspace/Knowledge-Library/02-Tasks/20260118-T1234-任务标题.md
```

## 依赖

- playwright-skill（浏览器自动化）
- doc-writer skill（文档创建）


ARGUMENTS: <任务ID>
