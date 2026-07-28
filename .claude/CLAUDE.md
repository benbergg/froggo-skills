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

ai-talk-tutorial(AI 演讲教程日报)
├── 强依赖 openclaw CLI(message send --channel feishu 推送,无 dingtalk-log 依赖)
├── 强依赖 YOUTUBE_API_KEY(Data API v3 发现层)
├── 强依赖 Node.js 18+(原生 fetch)
├── 软依赖 yt-dlp ≥2026.06(三级降级兜底;7-28 实测 tier2 web+cookies 可用)
└── 字幕层移植自 VM llm-video-log/subtitle.ts,两处需同步维护
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

### ai-talk-tutorial v2.1 (2026-07-28)

基于 7-28 首两篇真实产出的评估重构,五项按 B→C→D→A→E 顺序落地:

- **归档目录作为去重第二事实源**:`discover.js --archive` 扫归档 HTML 反查 video_id,与
  `processed.json` 取并集,淘汰原因分记 `processed` / `archived`。实证根因:归档由 Step 5
  前一步写、state 由末尾写,中间崩掉就留下"归档有成品、state 无记录"(当天归档 2 篇 state 1 条),
  次日重跑白烧一条流水线。归档 HTML 是最硬的已出过证据,扫它幂等。
- **正文 callout 疏堵结合**:支持 `[!tip]` / `[!warning]` / `[!note]` **封闭三种**,
  其余任何裸 `>` 由 C6 拦下 exit 5(金句段豁免)。实证:AI 自发写 `> [!tip]`,
  渲染成 `<p>&gt; [!tip] &gt; …</p>`,标记字面泄漏 + 样式全丢,而当时既无约束禁止也无自检能发现。
  渲染与自检共用 `parseCallout()`,避免"渲染认、自检不认"的错配。
- **金句有界清洗**:C3/C4 匹配前对金句与转录**两边**同做 `normalizeQuote`(去 um/uh/er/ah/mm
  等无实词歧义填充音 + 折叠连续重复词)。实证根因是约束打架:C4 精确子串 + "不得润色"叠加,
  必然产出 `Um and the way we we look at things ... is uh we don't trust anything.`。
  两边同归一化 → 子串关系不变,删实词/改词序/编造依然 exit 5。
  `like` / `actually` / `you know` / `basically` 是实词,明确排除在填充音集合外。
- **C9 专有名词溯源 + 可选第六段「术语对照」**:正文里**含大写字母**的英文词若在
  `full_text` 与 `selected.title` 中都查不到,必须在对照表声明,且声明的"转录原文"
  必须在 transcript 里真实存在。表渲染进 HTML 折叠区供人工复核。
  实证:同一篇里 `Deep Chem`→`DeepChem`(ASR 误听原样传播)、`we turn 360`→`Qwen3-360`
  (猜出不存在的型号)、`sweep bench agent less`→`swe-bench agentless`(纠对了)——
  三种命运说明完全没有机制在管,而错的 kernel 名进了「可落地 checklist」。
  **判别口径由真实产物校准**:该篇 145 个英文 token,转录+标题查不到 13 个,
  加"含大写字母"后剩 8 个、误报 0(滤掉的 orchestrated / ad-hoc / cross-rank 全是小写普通词)。
  C9 不保证纠对,保证的是每次改写显式声明且指向转录里真实存在的说法。
- **频道多样性降权**:近 7 天该频道每出过一次分数乘 0.55,历史存 `processed.json.history`
  (Step 5 写入,旧格式无该字段照常工作)。实证:当天两篇都来自 AI Engineer。
  做成降权而非排除,窗口滑动不是永久黑名单。

测试 101 项(100 pass / 1 skip),每项新增检查均经 revert-and-rerun 验证判别力。
`transcript-glossary.json` / `tutorial-glossary-{declared,undeclared}.md` 三个夹具
直接取自 7-28 真实产物 —— C9 的 0 误报断言只有贴生产形态的夹具才立得住。

## 版本管理

版本号在 `.claude-plugin/plugin.json` 的 `version` 字段中维护。
