---
name: froggo-workflow
description: "Start development workflow - 开发任务、新功能、Bug修复、重构"
arguments: "[mode]"
skill: froggo-workflow
---

# /froggo-workflow 命令

启动完整开发流程规范。

## 用法

```
/froggo-workflow [mode]
```

## 模式

| 模式 | 说明 | 阶段数 |
|------|------|--------|
| (默认) | 完整模式 | 9 阶段 |
| quick | 快速模式，跳过评审 | 7 阶段 |

## 示例

```
/froggo-workflow           — 完整模式（新功能、大重构）
/froggo-workflow quick     — 快速模式（小修复、配置调整）
```

---

**执行**：调用 `froggo-workflow` skill 处理
