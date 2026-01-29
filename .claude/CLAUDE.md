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

doc-writer
└── 依赖 obsidian:obsidian-markdown

doc-reader
└── 独立，查询知识库目录

zentao-syncer
└── 依赖 MCP: playwright (浏览器自动化)

requirement-gathering
├── 调用 doc-writer (文档输出)
└── 可选继续调用 superpowers:brainstorming (设计)
```

## 配置覆盖

项目可在自己的 CLAUDE.md 中覆盖默认配置：

```markdown
## froggo-skills 配置

- doc_root: /custom/path/to/docs
- templates_dir: /custom/path/to/templates
```

## 版本管理

版本号在 `.claude-plugin/plugin.json` 的 `version` 字段中维护。
