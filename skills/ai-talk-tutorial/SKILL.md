---
name: ai-talk-tutorial
description: "AI 演讲教程日报。每日从 YouTube 白名单频道(AI Engineer/YC/Anthropic/OpenAI/DeepMind/Sequoia/a16z 等)发现 AI/Agentic/模型公司高管演讲,打分选出当日 Top 1,AI 按五段模板提炼为可操作中文 How-to 教程,跑 C1-C8 自检(含时间戳与金句真实性校验),渲染自包含 HTML 归档知识库并推送钉钉摘要。触发词:AI 演讲教程、youtube 教程、演讲教程、talk tutorial、ai talk、今日演讲、大佬演讲、高管演讲、AI 日课。"
---

# AI 演讲教程日报

> 依赖 [`dingtalk-log`](../dingtalk-log/SKILL.md) 的 OpenAPI 封装。
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
| `DINGTALK_APPKEY` / `DINGTALK_APPSECRET` / `DINGTALK_USERID` | ✅ | 钉钉推送(全局共享) |
| `AI_TALK_COOKIES_PATH` | ☐ | YouTube cookie 文件,默认 `/home/ubuntu/.openclaw/workspace/astraeus/video素材/youtube-cookies.txt` |
| `AI_TALK_TEMPLATE_NAME` | ☐ | 钉钉模板名,**默认 `AI 演讲教程`**(固化在 skill) |
| `AI_TALK_DATE` | ☐ | 目标日期覆盖 `YYYY-MM-DD`,补跑历史日用 |
| `AI_TALK_ARCHIVE_DIR` | ☐ | 归档根目录,默认 `$HOME/workspace/Knowledge-Library/08-Research/AI-Talks` |
| `SEND_DINGTALK` | ☐ | `1/true/yes/on` 才真发;其余走 `--dry-run`。**仅 gate 推送这一步,不跳过其余步骤** |
| `YT_DLP_PATH` | ☐ | yt-dlp 二进制路径。未设时 `fetch-transcript.js` 依次探测 `/home/ubuntu/.local/yt-dlp-venv/bin/yt-dlp`、`$HOME/.local/yt-dlp-venv/bin/yt-dlp`、`$HOME/.local/bin/yt-dlp`、`/usr/local/bin/yt-dlp`、`/opt/homebrew/bin/yt-dlp`,都不存在才回落到 PATH 里的 `yt-dlp` |

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

### Step 0 · 解析钉钉模板

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"
mkdir -p "$WORK"

TPL_ID=$(node "$PLUGIN_ROOT/skills/ai-talk-tutorial/references/scripts/resolve-template.js" \
  --template-name "${AI_TALK_TEMPLATE_NAME:-AI 演讲教程}")
RC=$?
if [ $RC -ne 0 ] || [ -z "$TPL_ID" ]; then
  echo "FATAL: resolve-template.js exit $RC,模板解析失败,中止全流程" >&2
  exit $RC
fi
printf '%s' "$TPL_ID" > "$WORK/template_id.tmp" && mv "$WORK/template_id.tmp" "$WORK/template_id.txt"
```

用命令替换(`$(...)`)取 `TPL_ID` 而不是 `node ... > "$WORK/template_id.txt"` 直接重定向 —— shell 对 `>` 是**先创建/截断目标文件,再执行命令**,无论脚本退出码是什么,文件都会存在(失败时是空文件),会把下游"文件存在即可跑"的物理断路判断骗过去。`template_id.txt` 只在**确认成功**(exit 0 且 `TPL_ID` 非空)后原子落盘(先写 `.tmp` 再 `mv`)。**下游任何 exec,只要发现 `$WORK/template_id.txt` 不存在或为空,一律视为 Step 0 未成功,不得继续**,这是物理断路,不是提示词约束。

exit≠0 则**中止全流程**。

### Step 1 · 发现候选

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"

[ -s "$WORK/template_id.txt" ] || { echo "FATAL: Step 0 未成功(缺 $WORK/template_id.txt),中止" >&2; exit 1; }

node "$PLUGIN_ROOT/skills/ai-talk-tutorial/references/scripts/discover.js" \
  --out "$WORK" --today "$DATE" \
  --state "$HOME/.cache/ai-talk-tutorial/state/processed.json"
```

`--state` 显式传(默认值恰好等于 `<out>/../state/processed.json` = 同一路径,显式传是为了不让这条依赖藏在两个脚本的默认值巧合里 —— 改了 `$WORK` 定义就会静默失去去重能力)。

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
```

- exit 0 → 继续 Step 3
- **exit 6(全部候选取不到字幕)→ 中止,不产出半成品**:在同一个 exec 里 `export MSG="⚠️ AI 演讲教程今日生成失败:所有候选视频取字幕均失败(fetch-transcript.js exit 6),已中止,请人工核查候选与 cookie/yt-dlp 状态。"`,紧接着执行「简讯推送(共用块)」(见 Step 6 下方)的完整代码

### Step 3 · AI 撰写(本步在对话内完成,无脚本)

读 `$WORK/transcript.json`,按下述**五段模板**写 `$WORK/tutorial.md`。

````markdown
# <中文标题>

## 一、TL;DR

- 第一句
- 第二句
- 第三句

## 二、背景 · 他要解决什么问题

<正文段落>

## 三、核心方法论

### 1. <步骤名>
<正文>

### 2. <步骤名>
<正文>

### 3. <步骤名>
<正文>

## 四、可落地 checklist

- [ ] 第一项
- [ ] 第二项

## 五、原声金句

> [12:34] "the exact english sentence from the transcript"
> —— 中文译解
````

**撰写约束(违反必被 C1-C8 拦下)**:

1. 数字、术语、人名一律来自 `transcript.json`,**不得**用模型自身知识补充。
2. 金句必须**逐字引用**原文,不得改写、不得润色、不得拼接两句。
3. **时间戳标注惯例(硬约束,决定 C3 能否通过)**:`transcript.json` 的 `segments` 是
   `mergeSegments({minSec:30, maxSec:60})` 合并后的大段(段间距 31-62 秒),不是逐句字幕。
   `build-html.js` 的 C3 检查用「金句时间戳 ±10 秒窗口 + 该时间戳所在段及其**紧邻后继段**」
   校验金句真实性 —— 这个窗口**只向后延伸**,不含前一段。因此:
   - **优先选择完整落在单个 `segments[]` 条目内的句子作为金句**,只有找不到更好的选择时才用跨段句子。
   - 无论是否跨段,**时间戳一律取该句起始所在 segment 的 `startLabel`**,不得取结束所在段、不得取
     两段中较近的一段、更**不得估算**。若取成结束段的 `startLabel`,句子前半部分落在窗口覆盖不到的
     前一段,C3 会误判为假金句(build-html.js exit 5,整条流水线中止)。
4. 方法论**至少 3 步**,每步须有标题和正文。
5. 正文必须**完全独立可读** —— 禁止「详见视频 12:30」这类把内容外包给视频的写法(国内无代理时 iframe 与跳转链均不可用)。
6. 正文段落用中文;需要保留英文术语时嵌在中文句内,**不得**整段英文。
7. **金句的英文部分必须用 ASCII 直引号 `"..."`,不得用中文/弯引号 `“…”`**。`build-html.js` 的金句正则
   `/^>\s*\[...\]\s*"([^"]+)"\s*\n>\s*——\s*(.+)$/gm` 只认 ASCII `"`,用弯引号会导致该条金句从解析结果里
   彻底消失、不留痕迹。全部金句都坏掉时报 C4「未提供任何原声金句」;**只坏掉其中几条时也会被 C4 拦住**
   ——`build-html.js` 会比对「段落里看起来像金句的行数」与「实际解析出的条数」,数量不一致就报
   C4「原声金句部分丢失」,并在报错信息里点名最可能是弯引号导致(不会像 V1 那样只在全灭时才报错、
   部分丢失完全无感)。

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
  --out "$WORK/tutorial.html"
```

- exit 0 → 继续 Step 5
- **exit 5 → 读 stderr 的 `[Cx] 说明` 逐条修 `tutorial.md`,重跑本步。最多 3 轮**
- **3 轮仍不过 → 中止,不推送半成品**:在同一个 exec 里 `export MSG="⚠️ AI 演讲教程今日生成失败:tutorial.md 自检 3 轮仍未通过 C1-C8(build-html.js exit 5),已中止,不推送半成品,请人工核查 $WORK/tutorial.md 与上一次 stderr 报错。"`,紧接着执行「简讯推送(共用块)」(见 Step 6 下方)的完整代码

### Step 5 · 归档知识库

**单 exec 原子执行**(Knowledge-Library 有每小时自动 commit,拆成多个 exec 必撞车;`ARCHIVE`/`YEAR`/`SLUG` 也是 shell 局部变量,不跨 exec,归档 + 记录去重状态 + git 提交必须在同一个代码块里首尾相连跑完):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"

ARCHIVE="${AI_TALK_ARCHIVE_DIR:-$HOME/workspace/Knowledge-Library/08-Research/AI-Talks}"
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
WORK="$WORK" node - <<'JS'
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const work = process.env.WORK;
const state = path.join(os.homedir(), '.cache', 'ai-talk-tutorial', 'state', 'processed.json');
fs.mkdirSync(path.dirname(state), { recursive: true });
let seen = [];
if (fs.existsSync(state)) {
  try {
    seen = JSON.parse(fs.readFileSync(state, 'utf-8')).processed || [];
  } catch (e) {
    process.stderr.write('WARN: ' + state + ' 损坏(' + e.message + '),去重状态以空数组重建\n');
    seen = [];
  }
}
const vid = JSON.parse(fs.readFileSync(path.join(work, 'selected.json'), 'utf-8')).id;
if (!seen.includes(vid)) seen.push(vid);
fs.writeFileSync(state, JSON.stringify({ processed: seen.slice(-500) }, null, 2) + '\n');
JS
```

### Step 6 · 推送钉钉摘要(正常完成路径)

**构造摘要正文**(标题 + 频道 + 时长 + TL;DR + 归档路径):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"
ARCHIVE="${AI_TALK_ARCHIVE_DIR:-$HOME/workspace/Knowledge-Library/08-Research/AI-Talks}"
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
# 上面是普通赋值 MSG=$(node -e ...),不是 export MSG=$(...),所以 $? 本身其实
# 会正确传播 node 的异常退出码(实测 MSG=$(node -e "throw...");echo $? → 1;
# 只有写成 export MSG=$(...) 那种复合赋值才会把 $? 吞成 0 ——那是下面 F7 讲的
# 另一个坑,这里没有踩)。即便如此仍然改判空而不是判 $?:tutorial.md 缺失或
# TL;DR 正则匹配不到时 node 抛异常、stdout 为空,判空这一条规则就能同时兜住
# "node 异常退出"和"node 正常退出但恰好输出空字符串"两种情况,比只判 $? 更宽,
# 不用为两种失败模式分别处理。挡在这里(而不是等传进「简讯推送共用块」才被
# F7 的判空兜住)是为了给出更准确的失败原因。
[ -n "$MSG" ] || { echo "FATAL: MSG 构造失败(tutorial.md 或 selected.json 缺失/格式不对),中止推送" >&2; exit 1; }
export MSG
```

**紧接着在同一个 exec 里**,首尾相连贴上并执行下面「简讯推送(共用块)」的完整代码(依赖上面刚 `export` 的 `$MSG`)。

#### 简讯推送(共用块)

**exit 4 / exit 6 / 自检 3 轮失败 / Step 6 正常完成 四处共用**,自包含(自己解析 `PLUGIN_ROOT`/`DATE`/`WORK`,不依赖前面 exec 留下的 shell 变量,只吃调用方在同一个 exec 里已经 `export` 好的 `$MSG`):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -d "$PLUGIN_ROOT/skills/ai-talk-tutorial" ] || PLUGIN_ROOT="$HOME/.openclaw"
DATE="${AI_TALK_DATE:-$(date +%F)}"
WORK="$HOME/.cache/ai-talk-tutorial/$DATE"

# 调用方必须已经设好 $MSG(export 或普通赋值均可,下面 export 兜底);不校验的话
# dingtalk-log.js 只查 --contents 是不是合法 JSON 数组,不查数组里有没有 content
# 字段,空 MSG 会被静默广播成功(exit 0),而这个块恰恰是 exit 6 / 3 轮自检失败这两条
# 本该报警的路径在用,最坏后果是该报警的时候群里收到一条空消息
[ -n "$MSG" ] || { echo "FATAL: MSG 未设置,调用方必须先设置 MSG 再执行本块" >&2; exit 1; }
# 再 export 一次兜底:调用方如果写成普通赋值 MSG="..." 漏了 export,上面的判空
# 用的是 shell 变量、能通过,但下方构造 CONTENTS_JSON 时的 process.env.MSG 是子
# 进程读环境变量,不 export 就读不到,会拼出一条没有 content 字段的 payload、
# 照样静默广播成功
export MSG

TPL_ID=$(cat "$WORK/template_id.txt" 2>/dev/null)
if [ -z "$TPL_ID" ]; then
  echo "FATAL: $WORK/template_id.txt 缺失或为空,Step 0 未成功,无法推送" >&2
  exit 1
fi

TO_CIDS=$(node -e "
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const p = path.join(os.homedir(), '.cache', 'ai-talk-tutorial', 'template.json');
const convs = JSON.parse(fs.readFileSync(p, 'utf-8')).default_received_convs || [];
process.stdout.write(JSON.stringify(convs.map((c) => c.conversation_id)));
")

CONTENTS_JSON=$(node -e "
process.stdout.write(JSON.stringify([{
  key: 'AI 演讲教程', sort: '0', type: '1',
  content_type: 'markdown', content: process.env.MSG,
}]));
")

case "${SEND_DINGTALK:-0}" in
  1|true|TRUE|yes|on) SEND_FLAG="" ;;
  *) SEND_FLAG="--dry-run" ;;
esac

node "$PLUGIN_ROOT/skills/dingtalk-log/scripts/dingtalk-log.js" create-report \
  --template-id "$TPL_ID" \
  --userid "$DINGTALK_USERID" \
  --contents "$CONTENTS_JSON" \
  --to-chat true \
  --to-cids "$TO_CIDS" \
  $SEND_FLAG
```

> ⚠️ **必须同时传 `--to-chat true` 和 `--to-cids`**。钉钉 OpenAPI 实测 `to_chat=true` 单独**不会** fanout 到模板的 `default_received_convs`,不注入 cids 则群里收不到通知。

## 诚实上限

C1–C8 只能挡**结构性错误与引用真实性**。方法论提炼得准不准、有没有抓错重点属于模型发挥,**无法脚本化**。
重要用途请人工过一遍正文。

C7 只校验 `transcript.video_id` 与 `selected.id` 是否一致(防止拿错视频的字幕拼错视频的教程),**不做标题一致性校验** ——
`tutorial.md` 的 H1 与 `selected.json.title`(YouTube 原标题)本来就该不同(H1 是 AI 提炼的中文标题,不是原标题的翻译或摘录),
全流程没有、也不应该有任何一处比对两者是否"相符"。
