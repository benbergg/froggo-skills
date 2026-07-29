---
name: ai-talk-tutorial
description: "AI 演讲教程日报。每日从 YouTube 白名单频道(AI Engineer/YC/Anthropic/OpenAI/DeepMind/Sequoia/a16z 等)发现 AI/Agentic/模型公司高管演讲,打分选出当日 Top 1,AI 按五段模板提炼为可操作中文 How-to 教程,跑 C1-C12 自检(含时间戳、金句真实性与专有名词溯源校验),渲染自包含 HTML 归档知识库并推送飞书摘要。触发词:AI 演讲教程、youtube 教程、演讲教程、talk tutorial、ai talk、今日演讲、大佬演讲、高管演讲、AI 日课。"
---

# AI 演讲教程日报

> 通知走 openclaw 自带的飞书通道(`openclaw message send --channel feishu`),无外部 skill 依赖。
> 详细设计 [[20260727-youtube教程生成skill-v2-设计文档]]。
> **核心理念**:脚本做发现/取字幕/校验/渲染/推送,AI 只在 Step 3 做语言提炼。
> 每步产物落盘构成**物理断路** —— 上一步文件不存在,下一步跑不动。

## When to Use

触发词:**AI 演讲教程、youtube 教程、演讲教程、talk tutorial、ai talk、今日演讲、大佬演讲、高管演讲、AI 日课**。

`user-invocable: true`。手动与 cron 共享同一份 6 步代码路径,无人工确认分支。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `YOUTUBE_API_KEY` | ✅ | YouTube Data API v3 key,Step 1 发现层用;缺失时 `discover.js` exit 1 |
| `AI_TALK_FEISHU_TARGET` | ☐ | 飞书接收方 open_id,默认 `ou_4a9c3a58ae44cb2eda31c84dd86799e9`(与本机其余 cron 任务同一会话) |
| `AI_TALK_FEISHU_ACCOUNT` | ☐ | 飞书渠道账号,默认 `helios`。**open_id 按应用隔离**,换账号必须同时换 target |
| `AI_TALK_COOKIES_PATH` | ☐ | YouTube cookie 文件,默认 `/home/ubuntu/.openclaw/workspace/astraeus/video素材/youtube-cookies.txt` |
| `AI_TALK_DATE` | ☐ | 目标日期覆盖 `YYYY-MM-DD`,补跑历史日用 |
| `AI_TALK_ARCHIVE_DIR` | ☐ | 归档根目录,默认 `$HOME/Knowledge-Library/08-Research/AI-Talks`(**部署机的真实路径,不带 `workspace/` 一层**;开发机 vault 在 `~/workspace/Knowledge-Library/` 是另一回事,别照抄) |
| `AI_TALK_THUMB_MAX_KB` | ☐ | 封面 base64 后的体积上限,默认 400(KB)。超限则降级到更低画质;三档都超限就不配封面 |
| `SEND_NOTIFY` | ☐ | `1/true/yes/on` 才真发飞书;其余走 `--dry-run`。**仅 gate 推送这一步,不跳过其余步骤** |
| `YT_DLP_PATH` | ☐ | yt-dlp 二进制路径。未设时 `fetch-transcript.js` 依次探测 `/home/ubuntu/.local/yt-dlp-venv/bin/yt-dlp`、`$HOME/.local/yt-dlp-venv/bin/yt-dlp`、`$HOME/.local/bin/yt-dlp`、`/usr/local/bin/yt-dlp`、`/opt/homebrew/bin/yt-dlp`,都不存在才回落到 PATH 里的 `yt-dlp` |
| `DENO_PATH` | ☐ | deno 二进制路径,yt-dlp 解 n-challenge 用。未设时探测 `$HOME/.deno/bin/deno`、`/usr/local/bin/deno`、`/opt/homebrew/bin/deno`;都没有则不传 `--js-runtimes`,yt-dlp 会丢掉大量 format 与自动字幕轨 |
| `BGUTIL_POT_HOME` | ☐ | PO token provider 的 server 目录,默认 `$HOME/bgutil-ytdlp-pot-provider/server`。目录里有 `build/generate_once.js` 才切 `player_client=web`,否则用 yt-dlp 默认 client |

## 插件根目录解析

`CLAUDE_PLUGIN_ROOT` 只有 Claude Code 会注入,**openclaw exec 环境里它是空的**——`node ${CLAUDE_PLUGIN_ROOT}/...` 会展开成 `node /skills/...` 直接 `MODULE_NOT_FOUND`。本 skill 的 cookie 默认路径就是 `/home/ubuntu/.openclaw/...`,说明目标部署环境正是 openclaw exec,不能假设 `CLAUDE_PLUGIN_ROOT` 存在。

**每个 exec 都是独立 shell,变量不跨 exec**——下面每个代码块开头都重复这两行,不要因为"上一步刚定义过"就省略:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"
```

后续脚本调用一律用 `$PLUGIN_ROOT`,**不要**直接写 `${CLAUDE_PLUGIN_ROOT}`。

## 执行流程

> ⚠️ **前台 exec,单次 timeout ≥600s,禁用 `sleep` 轮询**。
> 每次轮询都是一次完整 LLM 推理 —— 2026-07-26 周报曾因 20+ 次轮询烧掉 163 万 token 且未推进任何步骤。

### Step 1 · 发现候选

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"
mkdir -p "$WORK"

ARCHIVE="${AI_TALK_ARCHIVE_DIR:-$HOME/Knowledge-Library/08-Research/AI-Talks}"

node "$PLUGIN_ROOT/skills/ai-talk-tutorial/references/scripts/discover.js" \
  --out "$WORK" --today "$DATE" \
  --state "$HOME/.cache/ai-talk-tutorial/state/processed.json" \
  --archive "$ARCHIVE"
```

`--state` 显式传(默认值恰好等于 `<out>/../state/processed.json` = 同一路径,显式传是为了不让这条依赖藏在两个脚本的默认值巧合里 —— 改了 `$WORK` 定义就会静默失去去重能力)。

**主题分组与轮换**:`channels.json` 把频道分到五个主题(`ai-tech` / `agentic` / `saas` /
`product` / `design`),每个主题有自己的一组关键词。视频的主题**只按标题判**,
在该频道声明的 topics 范围内取命中最多的一组;标题无信号时退回频道第一个主题。

不看 description 是 2026-07-28 VM 实测的结论:会议类频道给每条视频挂同一段宣传语,
描述里永远塞满该频道主业的词,计入后"按内容判主题"会退化成"按频道判主题"
(实例:`The Messy Reality of Scale: Synthetic Data and Pre-Training` 只按标题算
ai-tech 2 : agentic 0,加上描述后被判成 agentic)。

打分在频道降权之外再乘一次**主题降权**(近 `topicDays` 天该主题每出一次乘 `topicPenalty`)。
没有这一层,主题扩展就是纸面的:实测 90 天内落在时长区间的产出,LatentSpace 约 6 天一篇、
Lenny's 约 18 天一篇,`recencyDecay=0.85` 下后者扛着约 7 倍衰减劣势,永远选不上。
stderr 会报 `topics={...}` 分布 —— 长期只剩一个主题就说明频道 topics 标错或参数需要调。

`--archive` 是**去重的第二事实源**:扫归档目录里的 HTML 反查已经出过的 video_id。
`processed.json` 由 Step 5 末尾写入、归档由它前一步写入,中间任何一步崩掉都会留下
"归档里躺着成品、state 里没记录"的状态(2026-07-28 实证:归档 2 篇、state 只有 1 条),
次日会重新选中同一个视频白跑一整条流水线。两个来源取并集,淘汰原因分别记为
`processed` / `archived`,stderr 的 `archived=N` 报出本次扫到的条数。
归档目录不存在(首次运行)静默跳过;传成普通文件或读不动会 WARN 但不中止。

- exit 0 → 继续 Step 2
- exit 1(缺 `YOUTUBE_API_KEY` 或参数错)→ 中止,提示补齐 env 后重跑
- exit 2(YouTube API 全部调用失败)→ 中止并告警
- **exit 4(零候选)→ 不是失败,正常结束**:在同一个 exec 里 `export MSG="今日 AI 演讲教程:YouTube 白名单频道内未发现满足条件的新演讲,跳过本次生成。"`,紧接着执行「简讯推送(共用块)」(见 Step 6 下方)的完整代码

### Step 2 · 取字幕

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"

node "$PLUGIN_ROOT/skills/ai-talk-tutorial/references/scripts/fetch-transcript.js" \
  --candidates "$WORK/candidates.json" --out "$WORK"

# 封面大图。放在取字幕之后是因为它依赖 selected.json;失败只 WARN 不阻断,
# 所以不需要判它的退出码 —— 它永远 exit 0(除非参数写错)。
node "$PLUGIN_ROOT/skills/ai-talk-tutorial/references/scripts/fetch-thumbnail.js" \
  --selected "$WORK/selected.json" --out "$WORK"
```

`fetch-thumbnail.js` 从 `i.ytimg.com` 取官方封面并 base64 内嵌进 `thumbnail.json`,
按 `maxresdefault → sddefault → hqdefault` 降级。**不走 yt-dlp** —— 2026-07-28 实测
VM 上 yt-dlp 已因 cookie 轮换 + 缺 JS runtime 失效,而这几个缩略图端点免认证免 cookie,
是整条链路里最不容易坏的一环,插图不该挂在最脆的依赖上。

内嵌而非外链的理由:归档 HTML 要在知识库躺很多年,视频被删/转私有后外链封面会变成碎图标。
页脚那个 `<iframe>` 原视频本来就依赖 YouTube 在线,坏了不影响读文章;封面是版面的一部分,坏了直接破版。

**字幕层的三条硬约束**(2026-07-29 事故后加。当天 87 个候选里前 3 名字幕全取不到,
流水线一路静默滑到第 4 名的 2 分 12 秒产品广告片并把它做成了教程):

1. **cookie 只传副本**。`tryYtDlp` 把 cookie 复制到临时目录再传给 yt-dlp ——
   yt-dlp 退出时会**回写** `--cookies` 指向的文件,把 YouTube 轮换掉的字段覆盖进源文件。
   实测源文件被啃到只剩 13 个字段(1849B → 1610B)且不可逆,每跑一次损耗一次。
   源文件另存一份 `youtube-cookies.pristine.txt`,坏了直接覆盖回去。
2. **环境故障不再往下滑**。yt-dlp 的 stderr 命中 `Sign in to confirm you're not a bot` /
   `cookies are no longer valid` / `PO token was not provided` / `LOGIN_REQUIRED`
   → 判为环境故障,**立即 exit 7 中止**,不再尝试后续候选。
3. **转录体量下限**。`max(3000 字符, 时长分钟数 × 200 字符)`,不够就换下一个候选。
   挡两类东西:候选本身太短(2 分钟产品公告)、长视频只回来残片。

**InnerTube 两级默认停用**,`--tiers` 默认值就是 `yt-dlp`(写错名字直接 exit 1,
不会静默跳过所有级再伪装成 exit 6)。2026-07-29 用**完整 cookie**(12 个登录态字段
`SID`/`HSID`/`SSID`/`APISID`/`SAPISID`/`__Secure-1PSID`/`__Secure-3PSID`/… 全齐)实测:

| 路径 | 结果 |
|---|---|
| 第 2 级 `tryWebWithCookies`,完整 cookie | ❌ 仍 `LOGIN_REQUIRED` |
| yt-dlp + 同一份 cookie + PO token + web client | ✅ 1449 cues |

差异项是 **PO token + visitorData 绑定 + 当前 clientVersion** —— 要让第 2 级通,
等于在 Node 里把 yt-dlp 那部分重写一遍并跟着 YouTube 改。第 1 级更直接:
`tryAndroid()` 压根不传 cookie,IDC IP 上必然失败。且两级与 yt-dlp **共用同一份 cookie**,
是假冗余 —— cookie 一失效三级同时挂。停用后每天少发两次注定失败的请求
(这台机器正被 bot 检测盯着),日志里也不再有两条恒常 `LOGIN_REQUIRED` 盖住真问题。
代码保留,政策松动或换到住宅 IP 时 `--tiers android,web+cookies,yt-dlp` 开回即可。

**cookie 导出要过滤域**:整份浏览器 cookie 含其他站点(淘宝/内网/Notion 等)的登录态,
只能取 `.youtube.com` 与 `.google.com` 两个域再传上机器。

**yt-dlp 需要 JS runtime**:2026.06+ 靠它解 n-challenge,缺了会报
`n challenge solving failed` 并丢掉大量 format 与自动字幕轨。VM 上装在
`~/.deno/bin/deno`,脚本按 `DENO_PATH` env → `~/.deno/bin/deno` → 系统路径探测,
用 `--js-runtimes deno:<绝对路径>` 传给 yt-dlp(**不赌 cron 的 PATH**)。

**PO token provider**:装了才切 `player_client=web`,没装就用默认 client ——
没有 provider 的 web client 连 player API 都过不去,会把一个能工作的路径换成必然失败的路径。
2026-07-29 VM 实测三种组合:

| 组合 | 结果 |
|---|---|
| 无 cookie + PO token | ❌ 仍被 bot 检测拒 —— **IDC IP 上 PO token 替代不了登录态** |
| cookie + 默认 client(android vr) | ⚠️ 时好时坏,报 `Automatic captions for 1 languages are missing` |
| cookie + PO token + web client | ✅ 此前全败的两个视频都拿到字幕,`en-orig`/`en` 两轨齐全 |

部署(script mode,**不要 server mode** —— VM 只有 1.9G 内存,常驻进程不划算):

```bash
git clone --single-branch --branch 1.3.1 --depth 1 \
  https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /tmp/bgutil-build
cd /tmp/bgutil-build/server && npm ci --no-audit --no-fund && npx tsc
mkdir -p ~/bgutil-ytdlp-pot-provider && mv /tmp/bgutil-build/server ~/bgutil-ytdlp-pot-provider/server
/home/ubuntu/.local/yt-dlp-venv/bin/pip install -U bgutil-ytdlp-pot-provider   # 装进 yt-dlp 所在 venv
```

实测开销:token 生成单次 5 秒 / 峰值 199MB,整步端到端 10.15 秒 / 峰值 299MB。
`BGUTIL_POT_HOME` 可覆盖默认路径 `~/bgutil-ytdlp-pot-provider/server`。

- exit 0 → 继续 Step 3
- **exit 6(全部候选取不到字幕)→ 中止,不产出半成品**:在同一个 exec 里 `export MSG="⚠️ AI 演讲教程今日生成失败:所有候选视频取字幕均失败(fetch-transcript.js exit 6),已中止,请人工核查候选与 cookie/yt-dlp 状态。"`,紧接着执行「简讯推送(共用块)」(见 Step 6 下方)的完整代码
- **exit 7(字幕层环境故障)→ 中止,并且告警要指向 cookie 而不是候选**:在同一个 exec 里 `export MSG="⚠️ AI 演讲教程今日生成失败:字幕层环境故障(fetch-transcript.js exit 7),cookie 可能已失效或缺 PO token,已中止且未消耗候选,请重新导出 YouTube cookie 覆盖 youtube-cookies.txt。"`,紧接着执行「简讯推送(共用块)」的完整代码

### Step 3 · AI 撰写(本步在对话内完成,无脚本)

读 `$WORK/transcript.json` 与 `$WORK/selected.json`(取 `topic` 决定第三段形态),
按下述**七段模板**(第八段可选)写 `$WORK/tutorial.md`。

````markdown
# <中文标题>

## 一、TL;DR

- 第一句
- 第二句
- 第三句

## 二、背景 · 他要解决什么问题

<正文段落>

:::stats
13% | 团队内部日常使用该工具的比例
6T | 预训练语料的 token 量
:::

| 对比维度 | 方案 A | 方案 B |
|---|---|---|
| 适用场景 | ... | ... |

## 三、<按主题取标题,见下>

### 1. <步骤名 / 决策名>
<正文>

### 2. <步骤名 / 决策名>
<正文>

### 3. <步骤名 / 决策名>
<正文>

:::flow
1. <步骤名> | 一句话说明
2. <步骤名> | 一句话说明
3. <步骤名> | 一句话说明
:::

## 四、常见误区

- <常见做法> → <讲者主张的做法>
- <常见做法> → <讲者主张的做法>

## 五、可落地 checklist

- [ ] 第一项
- [ ] 第二项
- [ ] 第三项
- [ ] 第四项

## 六、落地到你的场景

<把方法论映射到读者自己的工作:从哪一步开始、先做什么、什么时候算走通>

## 七、原声金句

> [12:34] "the exact english sentence from the transcript"
> —— 中文译解

## 八、术语对照

| 教程写法 | 转录原文 | 依据 |
|---|---|---|
| DeepGEMM | Deep Chem | ASR 误听;DeepSeek 开源的 FP8 GEMM kernel |
````

**第三段标题按 `selected.json` 的 `topic` 取**(discover.js 已判好写进去,不要自己猜):

| topic | 第三段标题 | 每个 `###` 写什么 |
|---|---|---|
| `ai-tech` / `agentic` | `## 三、核心方法论` | 一个**可执行步骤**:做什么、怎么做、为什么这么做 |
| `saas` / `product` / `design` | `## 三、关键决策与权衡` | 一个**决策点**:面临什么局面、选了什么、放弃了什么、结果如何 |

两套只差第三段的标题与每步的叙事重心,**段落编号与其余各段完全一致** ——
自检不分叉,C5 照常要求 ≥3 个 `###` 且每步正文 ≥100 字符。
标题文字会被注入页面的 h2,写死在模板里的老做法已经取消,所以标题必须写对。

**第八段是可选段** —— 正文里所有英文术语都能在 `transcript.json` 或视频标题里查到时,可以整段省略。
一旦正文出现查不到出处的专有名词,C9 会点名要求补进这张表(见撰写约束第 8 条)。
**其余七段全部必填**,缺任何一段 C1 直接 exit 5。

**撰写约束(违反必被 C1-C12 拦下)**:

1. 数字、术语、人名一律来自 `transcript.json`,**不得**用模型自身知识补充。
2. **金句允许有界清洗,但不得改写**。可以做的只有两件事:
   - 删掉填充音:`um` / `uh` / `er` / `ah` / `mm` / `hmm` 及其拉长形式;
   - 折叠口吃式重复词:`we we look` → `we look`。

   **不可以**做的:增词、删实词、换词、改词序、拼接两句、修正语法。
   `like` / `actually` / `you know` / `basically` / `sort of` **是实词,不是填充音**,不得删。

   C3/C4 会把金句和转录**两边**都做同样的去填充音 + 折叠重复词处理再比对,
   所以清洗过的金句照样能匹配上;而删实词、改词序、整句编造依然不是子串,exit 5。
   这条 2026-07-28 放宽:此前"不得润色"叠加 C4 精确子串,必然产出
   `Um and the way we we look at things in my team is uh we don't trust anything.`
   这种噪音金句 —— 金句是这份产物的核心呈现物,可读性不该为防伪造买单。
3. **时间戳标注惯例(硬约束,决定 C3 能否通过)**:`transcript.json` 的 `segments` 是
   `mergeSegments({minSec:30, maxSec:60})` 合并后的大段(段间距 31-62 秒),不是逐句字幕。
   `build-html.js` 的 C3 检查用「金句时间戳 ±10 秒窗口 + 该时间戳所在段及其**紧邻后继段**」
   校验金句真实性 —— 这个窗口**只向后延伸**,不含前一段。因此:
   - **优先选择完整落在单个 `segments[]` 条目内的句子作为金句**,只有找不到更好的选择时才用跨段句子。
   - 无论是否跨段,**时间戳一律取该句起始所在 segment 的 `startLabel`**,不得取结束所在段、不得取
     两段中较近的一段、更**不得估算**。若取成结束段的 `startLabel`,句子前半部分落在窗口覆盖不到的
     前一段,C3 会误判为假金句(build-html.js exit 5,整条流水线中止)。
4. 方法论**至少 3 步**,每步须有标题和正文。**各段有最小内容量下限**(C1/C5/C12 逐条硬校验):

   | 位置 | 下限 | 2026-07-28 真实产出实测 |
   |---|---|---|
   | TL;DR 条数 | ≥3 | 3 |
   | 背景段 | ≥150 字符 | 578 |
   | 每个 `###` 的正文 | ≥100 字符 | 344 / 470 / 489 / 601 |
   | checklist 条数 | ≥4 | 7 |
   | 落地场景段 | ≥120 字符 | —(新增段) |

   这些是**下限不是目标值**,合格产出应远高于它们。阈值按实测的三分之一左右取,
   留足余量 —— C 类检查该拦的是"残缺",不是"写得一般";卡太贴近实测值,
   某天一个合格但简洁的步骤就会中止整条流水线。
   列表项行首用 `-`(checklist 用 `- [ ]`)或编号 `1.`,其他标记不计入条数。

5. 正文必须**完全独立可读** —— 禁止「详见视频 12:30」这类把内容外包给视频的写法(国内无代理时 iframe 与跳转链均不可用)。
6. 正文段落用中文;需要保留英文术语时嵌在中文句内,**不得**整段英文。
7. **正文里的 `>` 只有一种合法用法:三种 callout 之一** —— `> [!tip]` / `> [!warning]` / `> [!note]`
   (第五段金句区不受此约束,那里的 `>` 是金句格式本身)。语法固定:

   ````markdown
   前一段正文。

   > [!tip] 可选的标题写在同一行
   > 提示正文,可以多行,行首都要有 `>`。

   下一段正文。
   ````

   - callout **必须独立成段**,前后各留一个空行 —— 紧贴上文会被并进普通段落。
   - 类型是**封闭集合**,`[!abstract]` / `[!info]` 等 Obsidian 其他类型一律不支持。
   - **裸 `>` 引用行(不带 `[!type]`)不支持**,渲染层会把它当普通文本转义成 `&gt;` 破版。
     需要强调就用 callout,否则写成普通段落。

   以上三条违反都由 C6 拦下 exit 5。这条约束是 2026-07-28 实证补的:当时 AI 自发写了
   `> [!tip]`,产出的 HTML 是 `<p>&gt; [!tip] &gt; 关键工程法则:…</p>` —— 标记字面泄漏、
   `>` 转义、样式全丢,而当时没有任何一条约束禁止这么写,自检也没有任何一项能发现。
8. **专有名词必须可溯源,否则进术语对照表**(C9)。正文里**含大写字母**的英文词,
   若在 `transcript.json` 的 `full_text` 和 `selected.json` 的 `title` 里都查不到,
   必须在「## 六、术语对照」表里声明,三列缺一不可:

   | 列 | 要求 |
   |---|---|
   | 教程写法 | 正文里实际用的写法 |
   | 转录原文 | **必须是 transcript 里真实出现的文字**,ASR 拼错了也照填 —— C9 会去查,填个同样查不到的词会被拦 |
   | 依据 | 为什么这么改写(ASR 误听 / 转录用全称正文用缩写 / 依上下文推断……),不能为空 |

   **追溯不到就别用**:改回转录里的原说法,不要凭模型知识补写一个"看起来对"的名字。

   这条 2026-07-28 实证补的,当时同一篇稿子里同一类问题出现了三种命运:
   转录的 `Deep Chem FP8 kernels` 被原样写成 `DeepChem`(实为 ASR 误听);
   转录的 `we turn 360` 被猜成**不存在的型号** `Qwen3-360`;
   而 `sweep bench agent less multilingual` 又被正确纠成 `swe-bench agentless`。
   三种结果说明这件事完全没有机制在管 —— 一个错的 kernel 名字进了「可落地 checklist」,
   读者照着搜什么都搜不到,这份产物的核心卖点就没了。

   C9 不保证你纠对(机器判不了),它保证的是**每一次改写都被显式声明、且指向转录里真实存在的说法**,
   人工复核才有抓手。对照表会渲染进 HTML 末尾的折叠区,读者可以就地查证。
9. **金句的英文部分必须用 ASCII 直引号 `"..."`,不得用中文/弯引号 `“…”`**。`build-html.js` 的金句正则
   `/^>\s*\[...\]\s*"([^"]+)"\s*\n>\s*——\s*(.+)$/gm` 只认 ASCII `"`,用弯引号会导致该条金句从解析结果里
   彻底消失、不留痕迹。全部金句都坏掉时报 C4「未提供任何原声金句」;**只坏掉其中几条时也会被 C4 拦住**
   ——`build-html.js` 会比对「段落里看起来像金句的行数」与「实际解析出的条数」,数量不一致就报
   C4「原声金句部分丢失」,并在报错信息里点名最可能是弯引号导致(不会像 V1 那样只在全灭时才报错、
   部分丢失完全无感)。
10. **结构化图示只有三种,且只能写在第二、三、六段**(C10)。三千字中文连排没有呼吸,
    图示是解药,但语法必须封闭 —— 2026-07-28 那篇里 AI 自发写了一张 markdown 表格,
    当时渲染层不支持,整张以裸文本 `| 编排方式 | 适用场景 | 本质 | |---|---|---|`
    泄漏进正文,C1-C9 八项自检无一能发现。

    | 形态 | 语法 | 用在哪 |
    |---|---|---|
    | 流程 | `:::flow` … `:::`,每行 `步骤名 \| 一句话说明` | 方法论的步骤序列 |
    | 数字卡 | `:::stats` … `:::`,每行 `数值 \| 标签` | 值得被记住的关键数字 |
    | 表格 | 标准 markdown 表格 | 多维度对比 |

    - **位置**:只有「二、背景」和「三、核心方法论」两段会渲染它们。写进 TL;DR 或
      checklist 会被当成裸文本吞掉 —— C10 直接报位置错误,不给你静默破版的机会。
    - **闭合**:`:::` 块内部**不能有空行**,收尾必须是单独一行 `:::`。中间空一行会把块
      按段落切开,收尾的 `:::` 变成孤立文本。
    - **每项两段式**:`|` 左右都不能为空;至少 2 项(一项的图示没有信息量)。
    - **溯源**:`:::flow` 的节点名必须与正文里的步骤名一致,`:::stats` 的数值必须在正文
      出现过。**图是对正文的提炼,不是新的信息来源** —— 否则等于开了一个"在图里编造
      正文没有的数字"的口子,而图恰恰是读者最容易当结论记住的部分。
    - 表格每行列数必须与表头一致。

    不引 mermaid:自包含归档要内联 ~1MB 的 mermaid.js,一年归档就是 300MB+,
    为几张流程图不划算。这三种都是纯 CSS/HTML。
11. **常见误区每条写成 `<常见做法> → <讲者主张的做法>`**(C11),至少 2 条,
    箭头两侧都不能空、且一条里只能有一个 `→`。

    只写"别做 X"对读者没有可操作性,必须同时给出讲者主张的替代做法。
    用箭头而不是自由散文,是为了让"有没有给替代做法"这件事机器可判 ——
    否则这一段会退化成又一段泛泛而谈的正文,而它存在的意义恰恰是提供正文没有的对照。
    渲染出来是左右两栏(左「常见做法」右「讲者主张」),压成一行就跟普通列表没区别了。

    误区必须来自转录里讲者**明确反对**的做法,不是你觉得读者可能会犯的错。
12. **「六、落地到你的场景」是全篇唯一允许外推的段落,但不得引入新数字**(C12)。

    前五段严格转述讲者;这一段把方法论映射到读者自己的工作 —— 从哪一步开始、
    先做什么、什么时候算走通。这是整份产物里唯一由你组织的内容。
    正因如此它单独上锁:**段里出现的每个数字都必须在正文别处出现过**。
    专有名词由 C9 兜住(它覆盖全部正文段),数字是 C9 管不到的那一半 ——
    一个"把周迭代压缩到 3 天"式的具体数字读起来最像结论,却完全可能是顺手编的。
    要用某个数字,先在前面的段落里把它的来源写清楚;做不到就别写数字。

### Step 4 · 自检与渲染

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"

node "$PLUGIN_ROOT/skills/ai-talk-tutorial/references/scripts/build-html.js" \
  --md "$WORK/tutorial.md" \
  --transcript "$WORK/transcript.json" \
  --selected "$WORK/selected.json" \
  --thumbnail "$WORK/thumbnail.json" \
  --out "$WORK/tutorial.html"
```

`--thumbnail` 指向 Step 2 产出的封面。文件不存在或 JSON 坏掉只 WARN、页头退回纯色底 ——
不能因为封面挂了就丢掉一整篇已经通过全部自检的教程。

- exit 0 → 继续 Step 5
- **exit 5 → 读 stderr 的 `[Cx] 说明` 逐条修 `tutorial.md`,重跑本步。最多 3 轮**
- **3 轮仍不过 → 中止,不推送半成品**:在同一个 exec 里 `export MSG="⚠️ AI 演讲教程今日生成失败:tutorial.md 自检 3 轮仍未通过 C1-C12(build-html.js exit 5),已中止,不推送半成品,请人工核查 $WORK/tutorial.md 与上一次 stderr 报错。"`,紧接着执行「简讯推送(共用块)」(见 Step 6 下方)的完整代码

> C9 的修法和别的检查不同:它报的不是"写错了",而是"这个名字没有出处"。
> 两条正确出路 —— 要么把它连同转录原文和依据补进「## 六、术语对照」,
> 要么改回转录里的原说法。**不要**为了过检去编一个转录原文,C9 会回查。

### Step 5 · 归档知识库

**单 exec 原子执行**(Knowledge-Library 有每小时自动 commit,拆成多个 exec 必撞车;`ARCHIVE`/`YEAR`/`SLUG` 也是 shell 局部变量,不跨 exec,归档 + 记录去重状态 + git 提交必须在同一个代码块里首尾相连跑完):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"

ARCHIVE="${AI_TALK_ARCHIVE_DIR:-$HOME/Knowledge-Library/08-Research/AI-Talks}"
YEAR="${DATE%%-*}"
SLUG=$(node -e "
const s = require('$WORK/selected.json');
const t = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+\$/g, '').slice(0, 60);
process.stdout.write(t || s.id);
")
mkdir -p "$ARCHIVE/$YEAR"
cp "$WORK/tutorial.html" "$ARCHIVE/$YEAR/$DATE-$SLUG.html" \
  || { echo "FATAL: 归档 tutorial.html 失败" >&2; exit 1; }
cp "$WORK/tutorial.md"   "$ARCHIVE/$YEAR/$DATE-$SLUG.md" \
  || { echo "FATAL: 归档 tutorial.md 失败" >&2; exit 1; }

node "$PLUGIN_ROOT/skills/ai-talk-tutorial/references/scripts/build-index.js" --dir "$ARCHIVE" \
  || { echo "FATAL: build-index.js 失败" >&2; exit 1; }

# AI_TALK_ARCHIVE_DIR 可覆盖,归档目录不一定是仓库根往下正好两级 —— 用 git rev-parse
# 动态定位仓库根与相对路径,不硬编码 "08-Research/AI-Talks" 这层深度。
# $ARCHIVE 不在任何 git 仓库内时 rev-parse 会失败、REPO 为空 —— "cd \"\"" 在 bash/sh
# 里都返回 0 且不换目录,不挡这一下的话,后面 git pull/commit 会打到 exec 当前 cwd 那个
# 无关仓库上(有副作用),所以必须显式判空。
REPO=$(cd "$ARCHIVE" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
[ -n "$REPO" ] || { echo "FATAL: $ARCHIVE 不在 git 仓库内" >&2; exit 1; }
REL=${ARCHIVE#"$REPO"/}

# git commit 允许空 diff 时"失败"当成功处理:归档内容与仓库已有内容一致
# (同日重跑,或 Knowledge-Library 每小时自动 commit 抢在这一步之前把文件收走了)
# 时 `git commit` 会以非 0 退出且报 "nothing to commit",若不兜住,整链会在这里
# FATAL、processed.json 永远写不进去,次日又会重复选中同一个视频重新生成一遍。
# `git diff --cached --quiet` 无暂存差异时返回 0——只有在"commit 失败但索引里
# 确实还有未提交差异"(hook 拒绝、GPG 签名失败等真失败)时才返回 1,继续让整链 FATAL。
cd "$REPO" && \
git pull --rebase --autostash origin master && \
git add "$REL/$YEAR/$DATE-$SLUG.html" "$REL/$YEAR/$DATE-$SLUG.md" "$REL/index.html" && \
(git commit -m "docs: AI 演讲教程 $DATE" || git diff --cached --quiet) && \
(git push origin master || (git pull --rebase --autostash origin master && git push origin master)) \
  || { echo "FATAL: git 归档提交失败,不标记已处理(明日会重试)" >&2; exit 1; }

# 记录已处理,避免明日重复选中 —— 放在 git 链确认成功之后:
# 若提前(在 cp/git 之前)写这个状态,一旦后面任何一步失败(cp 失败/不在 git 仓库/
# push 冲突解不开),这个视频已经被标记"已处理",明天不会再选中,但内容其实从未
# 提交成功 —— 当天教程静默永久丢失且不可自愈。挪到这里,只有真正落库成功才计入去重。
#
# 读 processed.json 单独 try/catch(fix round FR5):discover.js 的 loadProcessed() 已经在
# 损坏时 WARN + 视为空集合,这里是同一份文件的另一处读取入口,原来是裸 JSON.parse ——
# 一旦文件损坏就会在这里抛异常,而这个 heredoc 排在 git push 成功之后,会把"git 已经
# 提交成功"的 Step 5 报成失败(容错策略与 discover.js 不一致)。改成损坏时 WARN 并以
# 空数组重建,不让它在 push 成功之后把整步炸掉。
WORK="$WORK" DATE="$DATE" node - <<'JS'
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const work = process.env.WORK, date = process.env.DATE;
const state = path.join(os.homedir(), '.cache', 'ai-talk-tutorial', 'state', 'processed.json');
fs.mkdirSync(path.dirname(state), { recursive: true });

let seen = [], history = [];
if (fs.existsSync(state)) {
  try {
    const o = JSON.parse(fs.readFileSync(state, 'utf-8'));
    seen = o.processed || [];
    history = o.history || [];
  } catch (e) {
    process.stderr.write('WARN: ' + state + ' 损坏(' + e.message + '),去重状态以空数组重建\n');
    seen = []; history = [];
  }
}

const sel = JSON.parse(fs.readFileSync(path.join(work, 'selected.json'), 'utf-8'));
if (!seen.includes(sel.id)) seen.push(sel.id);

// history 是 discover.js 频道降权与**主题降权**的唯一数据源 —— 缺了它两个 factor
// 都永远读到空数组、降权形同虚设,2026-07-28"两篇都来自 AI Engineer"会原样复发。
// topic 少写一个字段,主题轮换就静默失效而候选看起来一切正常。
if (!history.some((h) => h && h.id === sel.id)) {
  history.push({ id: sel.id, channel: sel.channelHandle || '', topic: sel.topic || '', date: date });
}

fs.writeFileSync(state, JSON.stringify({
  processed: seen.slice(-500),
  history: history.slice(-200),
}, null, 2) + '\n');
JS
```

### Step 6 · 推送飞书摘要(正常完成路径)

**构造摘要正文**(标题 + 频道 + 时长 + TL;DR + 归档路径):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"
ARCHIVE="${AI_TALK_ARCHIVE_DIR:-$HOME/Knowledge-Library/08-Research/AI-Talks}"
YEAR="${DATE%%-*}"
SLUG=$(node -e "
const s = require('$WORK/selected.json');
const t = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+\$/g, '').slice(0, 60);
process.stdout.write(t || s.id);
")

# 归档文件的存在性就是 Step 5 是否真的跑成功过的物理证据 —— 不校验的话,即使 Step 5
# 的 git 链失败了(F9 已让它不再静默吞掉),这里拼出来的路径依旧会被当成"已归档"塞进推送正文
ARCHIVE_HTML="$ARCHIVE/$YEAR/$DATE-$SLUG.html"
[ -f "$ARCHIVE_HTML" ] || { echo "FATAL: 归档文件 $ARCHIVE_HTML 不存在,Step 5 未成功执行,中止推送" >&2; exit 1; }

MSG=$(node -e "
const fs = require('node:fs'), path = require('node:path');
const sel = JSON.parse(fs.readFileSync(path.join('$WORK', 'selected.json'), 'utf-8'));
const md = fs.readFileSync(path.join('$WORK', 'tutorial.md'), 'utf-8');
const title = md.match(/^#\s+(.+)\$/m)[1].trim();
const block = md.match(/##\s*一、\s*TL;DR\s*\n([\s\S]*?)(?=\n##\s)/)[1];
const tldr = block.trim().split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
process.stdout.write(
  '**' + title + '**\n\n'
  + '🎙 ' + sel.channelTitle + ' · ' + Math.round(sel.durationSec / 60) + ' 分钟\n\n'
  + tldr + '\n\n'
  + '🔗 [原视频](' + sel.url + ')\n'
  + '📄 归档:' + '$ARCHIVE_HTML'
);
")
# 用普通赋值 MSG=$(node -e ...) 而不是 export MSG=$(...) —— 前者会正确传播 node 的
# 异常退出码(实测 MSG=$(node -e "throw...");echo $? → 1),后者那种复合赋值会把 $?
# 吞成 0。即便如此仍然判空而不是判 $?:tutorial.md 缺失或 TL;DR 正则匹配不到时 node
# 抛异常、stdout 为空,判空这一条规则能同时兜住"node 异常退出"和"node 正常退出但恰好
# 输出空字符串"两种情况,比只判 $? 更宽。挡在这里(而不是等传进「简讯推送共用块」才被
# 那边的判空兜住)是为了给出更准确的失败原因。
[ -n "$MSG" ] || { echo "FATAL: MSG 构造失败(tutorial.md 或 selected.json 缺失/格式不对),中止推送" >&2; exit 1; }
```

**紧接着在同一个 exec 里**,首尾相连贴上并执行下面「简讯推送(共用块)」的完整代码(依赖上面刚设好的 `$MSG`)。

#### 简讯推送(共用块)

**exit 4 / exit 6 / 自检 3 轮失败 / Step 6 正常完成 四处共用**,自包含(自己解析 `PLUGIN_ROOT`/`DATE`/`WORK`,不依赖前面 exec 留下的 shell 变量,只吃调用方在同一个 exec 里设好的 `$MSG`):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"

# 调用方必须已经设好 $MSG;不校验的话空消息会被当成一条正常通知发出去(exit 0),
# 而这个块恰恰是 exit 6 / 3 轮自检失败这两条**本该报警**的路径在用 —— 最坏后果
# 是该报警的时候飞书收到一条空消息,比不发还糟(看起来像跑成功了)
[ -n "$MSG" ] || { echo "FATAL: MSG 未设置,调用方必须先设置 MSG 再执行本块" >&2; exit 1; }

TARGET="${AI_TALK_FEISHU_TARGET:-ou_4a9c3a58ae44cb2eda31c84dd86799e9}"
ACCOUNT="${AI_TALK_FEISHU_ACCOUNT:-helios}"

case "${SEND_NOTIFY:-0}" in
  1|true|TRUE|yes|on) SEND_FLAG="" ;;
  *) SEND_FLAG="--dry-run" ;;
esac

openclaw message send --channel feishu --account "$ACCOUNT" -t "$TARGET" -m "$MSG" $SEND_FLAG
RC=$?
[ $RC -eq 0 ] || { echo "FATAL: openclaw message send exit $RC,飞书通知未发出" >&2; exit $RC; }
```

> ⚠️ **`--account` 必须显式传**。本机装了 4 个飞书账号(`helios`/`astraeus`/`forge`/`default`),不指定时会挑到别的应用，而 `open_id` 是**按应用隔离**的 —— 2026-07-28 实测漏传 `--account` 会被飞书拒绝：`feishu_code=99992361 open_id cross app`。默认 `ou_4a9c…` 这个 open_id 属于 `helios` 应用。
>
> ⚠️ **`--dry-run` 不校验收件人**。三个账号 dry-run 全部输出 `would run send via feishu`，只有真发才会暴露 `cross app` 错误。换 `AI_TALK_FEISHU_TARGET` 或 `AI_TALK_FEISHU_ACCOUNT` 后，必须真发一条验证，不能只看 dry-run。
>
> `openclaw` 只在 login shell 的 PATH 里(`bash -lc`)。openclaw cron 的 exec 本来就是 login shell,手动验证时若报 `command not found`,用 `bash -lc "..."` 包一层。
>
> `--dry-run` 只打印 payload 不发送,由 `SEND_NOTIFY` 控制 —— 它**仅 gate 发送这一步**,前面 Step 1-5 照常执行。

## 诚实上限

C1–C12 只能挡**结构性错误与引用真实性**。方法论提炼得准不准、有没有抓错重点属于模型发挥,**无法脚本化**。
重要用途请人工过一遍正文。

C10 的边界同理:它保证图示语法合法、位置正确、节点名与数值都能在正文里找到,
**不保证图示提炼得对** —— flow 的三步可能漏掉了正文里更关键的第四步,stats 挑的两个数字
可能不是最值得记住的两个。它挡的是"破版"和"图里凭空多出个数字",挡不了"选材平庸"。

C9 尤其要看清它的边界:它保证"每个转录里查不到的专有名词都被显式声明、且声明指向转录里真实存在的说法",
**不保证声明本身是对的**。`DeepChem` 这种 ASR 误听,C9 能逼 AI 写下"转录原文:Deep Chem",
但判不了正确拼法其实是 `DeepGEMM` —— 那需要外部知识。它的作用是把这类词从正文里挑出来摆到台面上,
让 HTML 末尾折叠区的那张表成为人工复核的入口。另外判别口径只认**含大写字母**的词
(真实产物校准:这样误报为 0),纯小写的专有名词漏放。

C7 只校验 `transcript.video_id` 与 `selected.id` 是否一致(防止拿错视频的字幕拼错视频的教程),**不做标题一致性校验** ——
`tutorial.md` 的 H1 与 `selected.json.title`(YouTube 原标题)本来就该不同(H1 是 AI 提炼的中文标题,不是原标题的翻译或摘录),
全流程没有、也不应该有任何一处比对两者是否"相符"。
