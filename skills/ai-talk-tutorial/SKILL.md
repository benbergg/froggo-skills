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
| `YOUTUBE_API_KEY` | ✅ | YouTube Data API v3 key,Step 1 发现层用 |
| `DINGTALK_APPKEY` / `DINGTALK_APPSECRET` / `DINGTALK_USERID` | ✅ | 钉钉推送(全局共享) |
| `AI_TALK_COOKIES_PATH` | ☐ | YouTube cookie 文件,默认 `/home/ubuntu/.openclaw/workspace/astraeus/video素材/youtube-cookies.txt` |
| `AI_TALK_TEMPLATE_NAME` | ☐ | 钉钉模板名,**默认 `AI 演讲教程`**(固化在 skill) |
| `AI_TALK_DATE` | ☐ | 目标日期覆盖 `YYYY-MM-DD`,补跑历史日用 |
| `AI_TALK_ARCHIVE_DIR` | ☐ | 归档根目录,默认 `$HOME/workspace/Knowledge-Library/08-Research/AI-Talks` |
| `SEND_DINGTALK` | ☐ | `1/true/yes/on` 才真发;其余走 `--dry-run`。**仅 gate Step 6,不跳过 Step 1-5** |
| `YT_DLP_PATH` | ☐ | yt-dlp 路径,默认 `yt-dlp` |

## 执行流程

> ⚠️ **前台 exec,单次 timeout ≥600s,禁用 `sleep` 轮询**。
> 每次轮询都是一次完整 LLM 推理 —— 2026-07-26 周报曾因 20+ 次轮询烧掉 163 万 token 且未推进任何步骤。

### Step 0 · 解析钉钉模板

```bash
export DATE="${AI_TALK_DATE:-$(date +%F)}"
export WORK="$HOME/.cache/ai-talk-tutorial/$DATE"
mkdir -p "$WORK"

node ${CLAUDE_PLUGIN_ROOT}/skills/ai-talk-tutorial/references/scripts/resolve-template.js \
  --template-name "${AI_TALK_TEMPLATE_NAME:-AI 演讲教程}" > "$WORK/template_id.txt"
```

exit≠0 则**中止全流程**。

### Step 1 · 发现候选

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/ai-talk-tutorial/references/scripts/discover.js \
  --out "$WORK" --today "$DATE"
```

- exit 0 → 继续 Step 2
- **exit 4(零候选)→ 跳到 Step 6 推「今日无内容」,正常结束**,不是失败
- exit 2 → 中止并告警

### Step 2 · 取字幕

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/ai-talk-tutorial/references/scripts/fetch-transcript.js \
  --candidates "$WORK/candidates.json" --out "$WORK"
```

exit 6(全部候选取不到字幕)→ **中止 + 钉钉告警**,不产出半成品。

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

### Step 4 · 自检与渲染

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/ai-talk-tutorial/references/scripts/build-html.js \
  --md "$WORK/tutorial.md" \
  --transcript "$WORK/transcript.json" \
  --selected "$WORK/selected.json" \
  --out "$WORK/tutorial.html"
```

- exit 0 → 继续 Step 5
- **exit 5 → 读 stderr 的 `[Cx] 说明` 逐条修 `tutorial.md`,重跑本步。最多 3 轮**
- 3 轮仍不过 → 中止 + 钉钉发失败告警,**不推送半成品**

### Step 5 · 归档知识库

```bash
ARCHIVE="${AI_TALK_ARCHIVE_DIR:-$HOME/workspace/Knowledge-Library/08-Research/AI-Talks}"
YEAR="${DATE%%-*}"
SLUG=$(node -e "
const s = require('$WORK/selected.json');
const t = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+\$/g, '').slice(0, 60);
process.stdout.write(t || s.id);
")
mkdir -p "$ARCHIVE/$YEAR"
cp "$WORK/tutorial.html" "$ARCHIVE/$YEAR/$DATE-$SLUG.html"
cp "$WORK/tutorial.md"   "$ARCHIVE/$YEAR/$DATE-$SLUG.md"

node ${CLAUDE_PLUGIN_ROOT}/skills/ai-talk-tutorial/references/scripts/build-index.js --dir "$ARCHIVE"

# 记录已处理,避免明日重复选中
node - <<'JS'
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const work = process.env.WORK;
const state = path.join(os.homedir(), '.cache', 'ai-talk-tutorial', 'state', 'processed.json');
fs.mkdirSync(path.dirname(state), { recursive: true });
const seen = fs.existsSync(state)
  ? (JSON.parse(fs.readFileSync(state, 'utf-8')).processed || [])
  : [];
const vid = JSON.parse(fs.readFileSync(path.join(work, 'selected.json'), 'utf-8')).id;
if (!seen.includes(vid)) seen.push(vid);
fs.writeFileSync(state, JSON.stringify({ processed: seen.slice(-500) }, null, 2) + '\n');
JS
```

git 提交(**单 exec 原子执行**,Knowledge-Library 有每小时自动 commit,必撞车):

```bash
cd "$(dirname "$ARCHIVE")/.." && \
git pull --rebase --autostash origin master && \
git add "08-Research/AI-Talks/$YEAR/$DATE-$SLUG.html" "08-Research/AI-Talks/$YEAR/$DATE-$SLUG.md" "08-Research/AI-Talks/index.html" && \
git commit -m "docs: AI 演讲教程 $DATE" && \
(git push origin master || (git pull --rebase --autostash origin master && git push origin master))
```

### Step 6 · 推送钉钉摘要

```bash
TPL_ID=$(cat "$WORK/template_id.txt")
TO_CIDS=$(node -e "
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const p = path.join(os.homedir(), '.cache', 'ai-talk-tutorial', 'template.json');
const convs = JSON.parse(fs.readFileSync(p, 'utf-8')).default_received_convs || [];
process.stdout.write(JSON.stringify(convs.map((c) => c.conversation_id)));
")

# 摘要正文:标题 + 频道 + 时长 + TL;DR + 归档路径
CONTENTS_JSON=$(node - <<'JS'
const fs = require('node:fs'), path = require('node:path');
const work = process.env.WORK;
const sel = JSON.parse(fs.readFileSync(path.join(work, 'selected.json'), 'utf-8'));
const md = fs.readFileSync(path.join(work, 'tutorial.md'), 'utf-8');
const title = md.match(/^#\s+(.+)$/m)[1].trim();
const block = md.match(/##\s*一、\s*TL;DR\s*\n([\s\S]*?)(?=\n##\s)/)[1];
const tldr = block.trim().split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
const body = `**${title}**\n\n`
  + `🎙 ${sel.channelTitle} · ${Math.round(sel.durationSec / 60)} 分钟\n\n`
  + `${tldr}\n\n`
  + `🔗 [原视频](${sel.url})`;
process.stdout.write(JSON.stringify([{
  key: 'AI 演讲教程', sort: '0', type: '1',
  content_type: 'markdown', content: body,
}]));
JS
)

case "${SEND_DINGTALK:-0}" in
  1|true|TRUE|yes|on) SEND_FLAG="" ;;
  *) SEND_FLAG="--dry-run" ;;
esac

node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js create-report \
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
