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

gold-forecast(黄金交易预测日报)
├── 强依赖 openclaw CLI(infer model run 调 MiniMax-M3 + message send 推飞书)
├── 强依赖 FRED_API_KEY(~/.config/gold-forecast/env)
├── 强依赖 GOLD_FEISHU_TARGET(push.js 无默认收件人,缺了直接 exit 1)
├── 强依赖 Node.js 18+、系统 unzip、flock(history-store upsert 无锁,靠编排层串行)
└── 零 npm 依赖,统计计算全自写并对拍验证
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

### ai-talk-tutorial v2.2 视觉改版 (2026-07-28)

7-28 真实产出的版面评估:全篇零图片,三千字中文段落在 940px 满宽下连排;
而 AI 其实**已经在自发写表格**了 —— 「核心方法论」的一张 markdown 表格因渲染层不支持,
整张以裸文本 `| 编排方式 | 适用场景 | 本质 | |---|---|---|` 泄漏进正文,C1-C9 八项无一能发现。

- **杂志长读风重排**:暖纸底 `#F4F1EC` + 衬线中文标题 + 正文栏宽从 940px 收到
  **720px**(超过 40 字/行时中文回扫会丢行,这是"没有呼吸"的主因)。章节序号用
  `01`/`02` 而非「一」/「二」—— 后者在 13px 衬线下就是一到三根横线,实测截图里
  与装饰线完全分不出。深色模式新增 `--on-accent`:深色下 accent 转浅橙,圆形序号
  再压白字对比度不足。`build-index.js` 的归档索引页同步同一套 token,避免两页像两个网站。
- **封面 hero**(`fetch-thumbnail.js`):`i.ytimg.com` 三档降级
  `maxresdefault → sddefault → hqdefault`,base64 内嵌。**不走 yt-dlp** —— 7-28 实测
  VM 上 yt-dlp 已因 cookie 轮换 + 缺 JS runtime 失效,而这几个端点免认证免 cookie。
  内嵌而非外链是因为归档要躺很多年,视频转私有后外链会变碎图标。
  三处判别来自真实行为:YouTube 对缺失画质返回 **200 + 1KB 灰色占位图**(不是 404,
  只看 `res.ok` 会把灰图当封面);JPEG magic 校验挡网关错误页;体积上限按
  **base64 编码后**算(才是 HTML 实际增量)。整步失败只 WARN + exit 0,页头退回纯色底。
- **结构化图示 + 表格渲染**(C10):封闭三种 —— `:::flow` / `:::stats` / 标准 markdown 表格,
  纯 CSS/HTML,**不引 mermaid**(内联 ~1MB,一年归档 300MB+)。C10 管四件事:语法闭合
  (块内不能有空行)、位置(只有二、三段走 `renderParagraphs`,写进 TL;DR/checklist 会被
  `renderList` 吞掉)、两段式完整性、**溯源**(flow 节点名须在方法论正文出现、stats 数值须在
  正文出现)。溯源这条与 C9 同源:图是对正文的提炼,不是新信息来源 —— 否则等于开了个
  "在图里编造正文没有的数字"的口子,而图恰恰是读者最容易当结论记住的部分。
- 本机 `node fetch` 打 i.ytimg.com 会 10s connect timeout 而 curl 正常:DNS 返回了不可达的
  AAAA(Teredo 前缀 `2001::1`),Node 认死 IPv6。`main()` 里开 `setDefaultAutoSelectFamily(true)`。

测试 126 项(125 pass / 1 skip),新增 fetch-thumbnail 11 项 + build-html 14 项。
10 组 revert-and-rerun 逐条验判别力,每组只打掉预期的那几项:去掉表格分支→只死 T54,
去掉 C10 整块→只死 T56-T63,只去掉溯源两行→只死 T60/T61,去掉占位图体积下界→只死 TT3。

### ai-talk-tutorial v2.3 主题扩展 + 内容加厚 (2026-07-28)

选题范围从「AI 公司高管演讲」扩到五个主题,教程从五段扩到七段。

**发现层**。新增 @LatentSpaceTV / @LangChain / @SaaStr / @LennysPodcast 四个频道
(均经 Data API 实测活跃度选出;@ProductSchool/@Reforge/@firstround 已停更或取不到,
@NNgroup 视频太短 90 天只 1 篇达时长线,@Figma 用户未选,故 design 主题有分类无稳定供给)。

- **光加频道不够,这是本轮最重要的结论**。实测 90 天内落在 8-100 分钟区间的产出:
  LatentSpace 约 6 天一篇、Lenny's 约 18 天一篇;`recencyDecay=0.85` 下 6 天前剩 0.38、
  18 天前只剩 0.054 —— 产品类扛着约 7 倍衰减劣势,加进白名单也一天选不上。
  故新增**主题降权** `topicFactor`(与频道降权同构相乘)强制轮换。
- 顺带发现**原关键词表几乎失效**:拿五频道真实标题跑,全部落在 0.70-0.82,
  而 `keywordCap` 是 1.6 从没被接近过 —— 排序实际由 `channel.weight × recency` 决定。
  改为按主题分组,每组都有够得着的加分项。
- **主题只按标题判,不看 description**。VM 实测:会议频道给每条视频挂同一段宣传语,
  描述里永远塞满频道主业的词,计入后"按内容判主题"退化成"按频道判主题"
  (`The Messy Reality of Scale: Synthetic Data and Pre-Training` 标题算 ai-tech 2:0,
  加描述后判成 agentic)。修正后真实分布从 `{agentic:32,saas:11,product:21,ai-tech:26,design:1}`
  变成 `{agentic:29,ai-tech:26,product:33,saas:3}` —— 原先的 saas/design 命中多是描述给的假信号。

**内容层**。五段 → 七段(第八段术语对照仍可选):新增「四、常见误区」与「六、落地到你的场景」。

- **C11 常见误区**:每条须写成 `<常见做法> → <讲者主张的做法>`,≥2 条。用箭头而非散文,
  是为了让"有没有给替代做法"机器可判;渲染成左右两栏对照。
- **C12 落地场景**:全篇唯一允许外推的段落,因此单独上锁 —— **段内每个数字都必须在正文别处出现过**。
  C9 覆盖专有名词,数字是它管不到的那一半,而"把周迭代压缩到 3 天"式的数字最像结论也最好编。
- **按主题分模板**:第三段技术类叫「核心方法论」、产品类叫「关键决策与权衡」。
  `SECTION_HEADS` 只认中文序号不认标题文字,**标题文字改由 md 注入 h2**(原先写死在模板里),
  于是模板与正文不可能各说各话,自检也无需分叉。
- **密度下限按实测重标**:背景 30→150、每步正文 15→100、checklist 2→4、TL;DR 2→3。
  旧值低到骨架文档也能过。新值取 7-28 真实产出(背景 578、每步 344-601、checklist 7)的
  三分之一左右 —— C 类检查该拦"残缺"不该拦"写得一般"。

测试 148 项(147 pass / 1 skip)。20 组 revert-and-rerun,其中一组暴露了假绿灯:
T31「产品类反超」最初三条历史都写同一频道,拿掉 `topicFactor` 照样通过 —— 翻转其实是
频道降权干的。改成三个不同频道同一主题后才真正测到主题降权。

### ai-talk-tutorial v2.4 字幕层塌方修复 (2026-07-29)

7-29 当天出了两篇,第二篇是 **2 分 12 秒的 OpenAI 产品公告**(`Introducing gpt-transcribe`)。
表面看像选题打分坏了,实际是**字幕层塌了之后的静默降级把烂候选顶了上来** ——
87 个候选里前 3 名(22/55/31 分钟的真演讲)字幕全取不到,`candidates.slice(0, maxTry)`
一路往下滑,撞到第 4 名那个碰巧有字幕的广告片就停了。

VM 手工复现 yt-dlp 拿到三条决定性 stderr,**生产日志里一条都没有**:

- **cookie 是残缺空壳**。只有 `__Secure-3P*` 系列,整套 1P 登录态(`SAPISID`/`SID`/
  `APISID`/`HSID`)全缺 —— InnerTube 的 android 与 web+cookies 两级**从 2026-07-27
  部署起就必然 LOGIN_REQUIRED,从来没工作过**,整条链路一直只靠 yt-dlp 一根独木桥。
  `fetch-transcript.js:163` 的注释里其实已记下此事,但只加了防御没修根因。
- **VM 无 JS runtime**。yt-dlp 2026.06+ 靠 deno 解 n-challenge,缺了报
  `n challenge solving failed` + `a PO token was not provided. Automatic captions
  for 1 languages are missing` —— **自动字幕整类拿不到**。
- **yt-dlp 在就地啃 cookie 文件**。`--cookies` 指向唯一源文件,yt-dlp 退出时**回写**
  cookie jar,把 YouTube 轮换掉的字段覆盖进去。实测 16 字段/1849B 被啃到 13 字段/1610B,
  不可逆,每跑一次损耗一次 —— 诊断过程本身也在加速破坏(第一次跑还能取到 379 cues,
  10 分钟后同一视频直接 `Sign in to confirm you're not a bot`)。

四项修复(A1-A4)。**关键判别口径来自当天真实 stderr**:环境故障与"这个视频没字幕"
两种 stderr **都**以 `There are no subtitles for the requested languages` 收尾,
只看这一句就会把"整个环境取不到"误判成"换一个视频就好" —— 事故原样重演。
故环境信号优先级高于无字幕信号。

- **A1 cookie 只传副本**:复制到临时目录再交给 yt-dlp,源文件永不被回写。
  另存 `youtube-cookies.pristine.txt` 供随时恢复。
- **A2 保留 stderr**:失败信息带 yt-dlp stderr 末 6 行(关键 WARNING 排在末尾,截头部正好丢掉)。
- **A3 环境故障 exit 7 中止**:命中 bot 检测/cookie 失效/PO token/LOGIN_REQUIRED
  → 不再滑向下一个候选;告警文案指向 cookie 而非候选。判定放在三级**都**失败之后 ——
  只要还有一级能取到,环境就算可用,不该因前两级 LOGIN_REQUIRED 就中止当天流水线。
- **A4 转录体量下限** `max(3000 字符, 分钟数 × 200)`:绝对下限挡"候选本身太短"
  (广告片 2052 字符,密度 933 字符/分其实正常,只看每分钟字数完全看不出问题);
  比例下限挡"长视频只取到残片"。200 的余量取自实测真实演讲的 523(有演示停顿)
  到 1012(纯口播)字符/分两端。
- 附带:`--tiers` 可指定启用哪几级;`DENO_PATH` + `--js-runtimes deno:<绝对路径>`
  显式传给 yt-dlp,**不赌 cron 的 PATH**。

修复后实测:`lyL5QhgIOxc` 379 cues、`jyuyY86GJnA` 1449 cues(原 `no json3 produced`),
cookie 源文件 sha256 与字节数跑前跑后完全一致。

测试 27 项(fetch-transcript),6 组 revert-and-rerun 逐条验判别力,每组只打掉预期的那几项:
去掉 cookie 副本→只死 T23,去掉 stderr 保留→只死 T24,去掉环境分流→只死 T25,
去掉体量校验→只死 T27,分类顺序颠倒→死 T15/T16/T19/T25,绝对下限归零→只死 T20。

**PO token provider(同日追加)**。装 `bgutil-ytdlp-pot-provider` 1.3.1 script mode,
三种组合实测结论明确:

| 组合 | 结果 |
|---|---|
| 无 cookie + PO token | ❌ 仍被 bot 检测拒 —— **IDC IP 上 PO token 替代不了登录态** |
| cookie + 默认 client(android vr) | ⚠️ 时好时坏,报 `Automatic captions for 1 languages are missing` |
| cookie + PO token + `player_client=web` | ✅ 此前全败的两个视频都拿到字幕,`en-orig`/`en` 两轨齐全 |

所以 PO token 的定位是**修好自动字幕缺失**,不是去 cookie 化。`resolvePotArgs()`
探测到 `build/generate_once.js` 才切 web client —— 没有 provider 的 web client
连 player API 都过不去,会把一个能工作的默认路径换成必然失败的路径。
选 script mode 而非 server mode 是内存决定的:VM 只有 1.9G(available 约 1.1G,
swap 已用 323M),常驻 Node 进程 24 小时只为每天用几次不划算;script mode
单次 5 秒 / 峰值 199MB,端到端 10.15 秒 / 峰值 299MB。

测试 30 项,9 组 revert-and-rerun。

**遗留**:
- `discover.js` 的最低时长仍只有 60 秒硬门槛(`<8min` 只 ×0.3 降权),1-2 分钟的
  产品发布片照样进候选池(当天 87 个候选里 36 个短于 8 分钟)。A4 只能挡它进 Step 3,
  挡不住它占据排名。
**InnerTube 两级默认停用(同日,补完整 cookie 后的结论)**。先用
`yt-dlp --cookies-from-browser chrome` 补齐了 HttpOnly 那批字段
(Cookie Editor 只导出非 HttpOnly 的,分界线与 HttpOnly 完全吻合,
说明它走的是 `document.cookie` 而非扩展 API),12 个登录态字段全齐后:

| 路径 | 结果 |
|---|---|
| 第 2 级 `tryWebWithCookies`,**完整** cookie | ❌ 仍 `LOGIN_REQUIRED` |
| yt-dlp + 同一份 cookie + PO token + web client | ✅ 1449 cues |

**cookie 完整性不是第 2 级失败的原因**,差异项是 PO token + visitorData 绑定 +
当前 clientVersion —— 修它等于在 Node 里重写 yt-dlp 那部分并跟着 YouTube 改。
第 1 级 `tryAndroid()` 压根不传 cookie,IDC IP 上必然失败,是死代码。
且两级与 yt-dlp 共用同一份 cookie,**是假冗余** —— cookie 一失效三级同时挂。
故 `DEFAULT_TIERS = ['yt-dlp']`,代码保留可用 `--tiers` 开回;未知 tier 名
exit 1(静默 filter 掉会让每个候选零级可跑→直落 exit 6,把排查引向无关方向)。
停用后端到端 10.15s → 8.70s,日志只剩一行 `✓ yt-dlp: N cues`。

**cookie 导出的安全约束**:浏览器整份 cookie(实测 458 条)含淘宝/公司禅道
`chandao.bytenew.com`/`work.bytenew.com`/Notion 等登录态,**必须只过滤出
`.youtube.com` 与 `.google.com` 两域**(40 条)再传上云主机。

测试 33 项,11 组 revert-and-rerun。**遗留的真实单点**:整条链路只剩 yt-dlp 一级,
且它与已停用的两级共用同一份 cookie —— 提高存活率要靠告警(exit 7 已做)
与 cookie 轮换流程,不是靠这两级。

### gold-forecast V1 (2026-07-30)

详见知识库 [[20260729-黄金交易预测skill-v1-设计文档]]。四层结构:确定性采集 /
量化基线 / LLM 调整 / 自检物理断路,并新增前三个 skill 都没有的**结算层** ——
反思能否成立全在于此。入口只有 `run.js`,编排顺序即正确性约束。

- **结算与预测按依赖面切开**。`collect-settlement`(仅 LBMA)→ `settle` → `scorecard`
  三步只依赖一个序列,东财或 FRED 全挂也照常完成;`collect-facts`(其余 7 源)失败
  只丢当天的预测,不丢当天的结算。原设计把采集合成一步,于是东财故障那天连结算也停了。
- **建模的训练与预测走同一条数据路径**。`collect-facts` 把当日数据追加进 `history/`,
  `baseline.js` **只读 history、完全不认识 facts.json**。两条路径只要在单位/缺失填充/
  日期对齐/修订处理上有任何差异,就是在一个分布上训练、在另一个分布上预测 ——
  不报错、回测漂亮、实盘失效。
- **模型 pin 到 M3,不符即降级为只发基线**。openclaw 的 fallback 链在一般应用里是
  可用性优点,在测量系统里是污染源(本仓库有 failover 混入视觉模型 VL-01 的前科)。
  对一个要回答「M3 的调整是否加分」的系统,「今天没有 LLM 预测」优于「今天的预测来自
  另一个模型」——前者只少一个样本,后者是往数据里掺沙子。
- **E2BIG 与网关超时的返回值只差 signal/error**。`infer model run` 只有 `--prompt`,
  受 `MAX_ARG_STRLEN` 限制,超限签名是 `exit=null` + stdout 空 + 约 3ms 返回。
  它与超时被 kill 在 `status`/`stdout` 上完全一致,只有 `signal`(null vs SIGTERM)与
  `error.code`(E2BIG vs ETIMEDOUT)能分。只看前两个字段就会把网关变慢判成「prompt
  太大」⇒ 不重试也不算 infra,真故障静默吞掉。故环境信号优先级高于超长信号。
- **naive 基准必须取 `features.p0_N`,不能取 `horizons.*.baseline.prob_up`**。后者在
  该周期 logistic 通过验收后就不再等于 p0。缺写入端时生产上每条结算都回退 0.5,
  `p0_20=0.60` 时基准被抬高 0.0100 —— **正好是回测验收门槛 `minGain=0.005` 的两倍**,
  这个 bug 送的虚假增益比它要跨过的门槛还大一倍。
- **c9_triggered 必须独立复算,不能从自检 findings 反推**。`checkC9` 只在模型没能给出
  合格理由时才产 finding;一个每天大幅偏离基线却每次都写了工整理由的模型 findings 里
  干干净净 ⇒ 20 天全记 false ⇒ 那条复查线永远触发不了,而这恰是设计最想抓的情形。
- **进 prompt 的每个数字都必须可引用**。`build-prompt` 把整个 scorecard 塞进不可截断的
  calibration 块,而 C4 的允许池只取 `by_horizon` ⇒ 顶层 `data_quality`(剔除计数)
  模型看得见却不在池里,一引用就触发 C4 → 三轮修复全废。序列化前剥掉。
- **target_date 外推不能用 `lib/trading-calendar.js` 的 `nthSession`**。生产上
  `calendar_tail` 全是过去的定盘日、末元素就是 today,`filter(d > anchor)` 恒空、
  每次返回 null。它当初是对着一个「fromDate 后面还有余量」的夹具验的。改用工作日
  递增,未知假日的偏差由 `settle.js` 的 approx 分支在结算时自我纠正。
- **回填窗口 7 个完整日历年不能改短**。卡样本量的不是价格 spine(不按日期过滤、
  全量历史),而是三特征的联合覆盖窗口:`可评估条数 = 覆盖窗口 − 95 − 250 − 2n`。
  实测 6.0 年 long 只剩 1115 条 < 1200 下限。调短会让验收门槛**静默失效**。
- **`history-store` 的 upsert 是无锁读-改-写**:两进程并发实测应留 300 条只落
  103-154 条,无异常无非 0 退出码。库层刻意不加锁(那是把编排层的问题伪装成已加固),
  串行由 cron 的 `flock` 保证。
- **退出码分层**:`commit`/`push` 的运行期异常退 5、参数错退 1、备份失败退 3。
  `run.js` 把 3 判成**成功**(入库归档已完成、重跑幂等)—— 判成失败会为了修一个
  rsync 问题重跑整条流水线再付一次模型费用;退出码仍透传 3 保持刺眼。
- **`SEND_NOTIFY` 未设 = 通知层静默关闭且退 0**。`push.js` 未设它时走 `--dry-run`
  并退 0 ⇒ run.js 判 success ⇒ 整体 exit 0,链路全绿而报告与失败简报都永不到达。
  这是全系统唯一一处「完全正常」与「通知层完全关闭」外观一致的地方,故 cron 清单里
  它与 key 同等必填,run.js 也会显式 WARN。
- **进 prompt 的数字与 C4 允许池必须出自同一个投影**(`lib/prompt-payload.js`)。
  两处各写一份必然漂移,而且是双向的:池窄于 prompt 时,模型引用自己看到的数字就被
  block —— 设计 8.1 要求第五段写覆盖率与 abandoned 计数,它们在 `scorecard.coverage`,
  旧池不含,等于**自检在阻止报告满足设计**。反方向的一半是「不想被引用的数字就别送」,
  故运维诊断 `data_quality` 从 payload 里剥掉,剥掉后它自然也不在池里。
- **环境信号优先级高于超长信号,且必须白名单而非枚举**。`oversize` 的兜底判据
  (`status===null && !stdout`)会吃掉一切 `error.code`,只补 `ETIMEDOUT` 仍会让
  `ENOENT`/`EACCES`(OPENCLAW_BIN 配错、丢执行位)判成「prompt 太大」。
- **权威库「不见了」与「还没有」必须分开**。缺失时静默新建空库的后果链全程 exit 0:
  settle 在空库上跑 → scorecard 全 insufficient → commit 只入一条 → rsync 同名覆盖
  把备份也换成单条版本。判据用 `run-state.json` 或 `versions/` 是否存在。
- **测试套件的零外部流量要靠机制而非自觉**。子进程拿的是白名单 env、不继承
  `NODE_OPTIONS`,所以 `helpers.runCli` 强制注入断网 shim;曾有一条 CLI 测试跑完整
  `runPipeline` 真打 LBMA 端点,而它的断言是 `status !== 5`,通网断网都成立。
- 测试 423 项。判别力全部经 revert-and-rerun,**四处暴露假绿灯**:①「naive_p 取 p0_N」
  在 `model:'p0_N'` 的夹具下与取 `baseline.prob_up` 完全同值,必须造一个 logistic
  已生效的夹具才测得到;②「删产物只在最终放弃时」换成 `!passed` 照样全绿 ——
  两者只在 pin 不符中途 break 时才分叉;③ 源冻结告警的阈值断言拿常量自身去算种子数,
  会跟着常量一起缩放,阈值改成 2 也照样绿;④ `status !== 5` 那条对任何回归都成立。
  共同点:**断言必须钉在绝对的、外部的判据上**,拿被测对象自己算出来的期望值等于没测。

## 版本管理

版本号在 `.claude-plugin/plugin.json` 的 `version` 字段中维护。
