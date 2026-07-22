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

exp-compass-daily(体验罗盘日报,V3.1 取代 V2)
├── 强依赖 zentao-api(token 缓存 + zt-functions.sh 桥接)
├── 强依赖 dingtalk-log(get-template 查模板 + create-report 广播)
├── 强依赖 Node.js 18+(原生 fetch + AbortController)
└── 软依赖 bash 4+(401 token 重取 fallback)

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

### exp-compass-daily V3 行为变化

详见 [[20260511-体验罗盘日报-V3-设计文档]]:
- 删除 Step 4 AskUserQuestion,cron 与 manual 共享同一份代码路径
- 钉钉日志首段注入 `**📅 汇报日期 YYYY-MM-DD**` 粗体(原 quote 形式被钉钉渲染器截断成 `&g`)
- 研发概览段表格转 emoji 行(无 `- ` 前缀,钉钉吃掉 markdown list bullet)
- 钉钉 OpenAPI 调用全部走 dingtalk-log skill,exp-compass-daily 不再维护自己的 push 实现

### exp-compass-daily V3.1 第二次 pivot (2026-05-11)

- **推送语义**:无广播日志 → **广播到模板 `default_received_convs`**。理由:用户每天打开 APP 手动转发反而比 V2 直接广播体验差,自检 6 项已兜底质量。
- **模板配置**:`DINGTALK_EXP_COMPASS_TEMPLATE_ID` env → **模板名固化在 skill**(默认 `体验罗盘日报`),Step 0 由 `resolve-template.js` 按名查 template_id 并缓存到 `~/.cache/exp-compass-daily/template.json`。理由:模板 ID 入 env 易和其他 skill 串台(参考 2026-05-11 OPT 学习笔记群误广播事件)。
- **新文件**:`references/scripts/resolve-template.js` + `tests/run-resolve-template-tests.js` (10 BDD)
- **删除 env**:`_TEMPLATE_ID` / `_TO_CHAT` / `_TO_USERIDS` / `_TO_CIDS` 全部移除,广播范围由钉钉后台模板配置决定
- **5-11 晚 sub-pivot 第 2 条**:钉钉 OpenAPI 实测 `to_chat=true` **单独不会** fanout 到 `default_received_convs`,**必须显式**把 `default_received_convs[].conversation_id` 注入 `--to-cids` 才会真触发群通知。Step 6 从 cache 读 cids 拼数组传给 dingtalk-log。这条规律也修正了 dingtalk-log SKILL.md 早期"to_chat=true 自动广播"的错描述

### exp-compass-daily V4 (2026-07-22)

详见 [[20260722-体验罗盘日报-V4-设计文档]],基于 7-21 报告 21 项问题实证的重构:
- **需求推进分层**:详情表只列 `is_active` 需求(developing 恒活跃;developed/tested 需当日动态/未完任务/逾期),任务行过滤 + `└ 另有 N 个任务已完成` 表尾;其余收敛一行 `⏸ 已研发完毕待推进`(带滞留天数);逾期需求置顶标 ⚠️
- **存量风险子段**(二段末尾 H2):待验收超期 bug(resolved>3 天)/隐形逾期任务(挂在未开始需求下)/待修复 bug——解决"概览数字无处 drill-down"
- **执行人口径统一**:新增任务用 `display_handler` 不用 openedBy(91% 任务组长拆卡);完成需求拆组禁 `?? assignedTo` 回退(禅道完成后 assignedTo 流转回创建人,实证 T45717);修复 Bug `[修@x 验@y]` 角色拆显
- **概览语义修正**:BUG 行重映射 in_progress=active/todo=resolved + `ℹ️` 脚注(禁 `>` blockquote,钉钉 `&gt;`→`&g` 乱码);需求行 `{active} (另滞留 {stale})`
- **is_today_done 拓宽**:closed→closedDate 当天;released/verified→lastEditedDate 当天近似;新增"今日测试完毕"段(三段共 7 子段)
- **自检 C1-C8**:C5 重定义为"逾期全集 ⊆ 详情表 ∪ 存量风险"(原规则严格不可满足);C7 从全局 grep 升级为条目级角色字段校验;新增 C8 跨段一致性
- **collect.js 新派生**:story.is_active/stale_days/last_activity_date/is_today_tested、task.overdue_days、bug.resolved_age_days/display_title/display_reporter、summary.story.{active,stale}
- build-draft.js:概览第 2 列允许非纯数字、表格外说明行(脚注)转换后保留
- 测试:`tests/run-derive-v4-tests.js`(34 项)+ build-draft V4 3 项

## 版本管理

版本号在 `.claude-plugin/plugin.json` 的 `version` 字段中维护。
