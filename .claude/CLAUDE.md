# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

froggo-skills 是一个 Claude Code 插件，提供开发者工作流增强技能。本项目是纯 Markdown 配置项目，无编译构建步骤。

## 开发命令

```bash
# 本地测试安装（在 Claude Code 中）
/plugin install /Users/lg/workspace/froggo-skills

# 卸载
/plugin uninstall froggo-skills

# 查看插件状态
/plugin list
```

## 架构

### 组件结构

```
froggo-skills/
├── .claude-plugin/
│   └── plugin.json          # 插件元数据（版本、描述）
├── skills/                   # 技能定义（自动/手动触发的工作流规范）
│   └── {skill-name}/
│       └── SKILL.md         # 技能规范文件
├── commands/                 # 用户命令入口（/xxx 形式调用）
│   └── {command-name}.md    # 命令定义，指向对应 skill
└── hooks/
    ├── hooks.json           # Hook 配置
    └── knowledge-lib-hook.sh # 知识库检测脚本
```

### Skill vs Command

- **Skill (skills/)**: 定义工作流规范和行为指令，可被 Claude 自动触发或手动调用
- **Command (commands/)**: 用户命令入口 (`/xxx`)，通过 `skill:` frontmatter 字段指向对应 skill

### Skill 文件格式

```markdown
---
name: skill-name
description: "触发条件描述 - 中英文关键词"
---

# 技能标题

## Overview
## When to Use
## Quick Reference
## 规则/流程
## 示例
```

### Command 文件格式

```markdown
---
name: command-name
description: "命令描述"
arguments: "[optional-args]"
skill: target-skill-name
---

# 命令说明
```

### Hook 机制

`hooks/hooks.json` 配置 PreToolUse/PostToolUse 事件钩子：
- `matcher`: 正则匹配工具名
- `command`: 执行的 shell 命令，使用 `${CLAUDE_PLUGIN_ROOT}` 引用插件根目录
- Hook 脚本从 stdin 读取 JSON 格式的 `tool_input`

## 技能依赖关系

```
git-commit
└── 独立，无外部依赖

zentao-api
└── 独立，提供 token 缓存(~/.cache/zentao/token.json)和 zt-functions.sh 函数库

exp-compass-daily（体验罗盘日报，V2 取代 V1 daily-report）
├── 强依赖 zentao-api（token 缓存 + zt-functions.sh 桥接）
├── 强依赖 Node.js 18+（原生 fetch + AbortController）
└── 软依赖 bash 4+（401 token 重取 fallback）

weekly-report
└── 强依赖 zentao-api

prompt-engineering
└── 独立，无外部依赖
```

### exp-compass-daily 设计文档

详细设计见知识库 [[20260507-体验罗盘日报-V2-设计文档]]:
- 三层架构（数据采集 JS / AI 撰写 / 推送 + 自检）
- 6 条撰写约束（数字必用 summary、stage 范围、6 段 filter、总结具体性、字段映射、H1 锚点）
- 6 项自检 C1-C6（cross-check MD vs JSON）+ 3 轮上限
- token 防泄漏 6 条细则
- V1 关系矩阵（取代 collect-stories.sh / aggregate.sh / render.sh / check.sh 等 ~10 个脚本）

## 版本管理

版本号在 `.claude-plugin/plugin.json` 的 `version` 字段中维护。
