#!/usr/bin/env node
'use strict';
// tutorial.md → C1-C8 自检 → 自包含 tutorial.html。
//
// 物理断路:任一自检不过则 exit 5 且不写 HTML,下游 git/推送步骤自然无文件可用。
// 注入逻辑逐单元构建(禁全局跨块正则),沿用 V1 youtube-tutorial-maker/scripts/integrate.py 的教训。
//
// 退出码:0=通过 1=参数错 5=自检失败

const fs = require('node:fs');
const path = require('node:path');

const SECTION_KEYS = ['tldr', 'background', 'method', 'checklist', 'quotes'];
const SECTION_HEADS = {
  tldr: /^##\s*一、\s*TL;DR/m,
  background: /^##\s*二、/m,
  method: /^##\s*三、/m,
  checklist: /^##\s*四、/m,
  quotes: /^##\s*五、/m,
};
// 英文项用 \b 词边界(避免误伤如 "TODOLIST" 这类复合词);
// 中文项不能用 \b —— 无 u 标志时 \b 定义在 ASCII [A-Za-z0-9_] 上,CJK 字符两侧根本不存在词边界,
// 混进同一个 \b(...)\b 组会导致中文占位符永远匹配不到(fix round: 评审实测 test('待补充')===false)。
const PLACEHOLDER_RE = /\b(?:TBD|TODO|FIXME|XXX)\b|待补充|占位|待填/i;

// 正文允许的 callout —— 封闭集合,不是任意 Obsidian 语法。
// 2026-07-28 实证:AI 自发写了 `> [!tip]`,渲染成 `<p>&gt; [!tip] &gt; …</p>` ——
// 标记字面泄漏、`>` 转义、样式全丢。AI 有强调的表达需求,堵不如疏:支持这三种,
// 其余任何以 `>` 开头的正文行由 C6 拦下(金句段豁免 —— 那里 `>` 是格式本身)。
// 集合必须封闭:开放给任意类型,下次换成 [!abstract] 又是一次静默破版。
const CALLOUT_TYPES = ['tip', 'warning', 'note'];
const CALLOUT_HEAD_RE = /^>\s*\[!([a-zA-Z]+)\]\s*(.*)$/;

// 合法 callout → { type, title, body };不是 → null。
// 渲染与 C6 自检共用这一个判定,避免"渲染认它、自检不认"(或反过来)的错配。
function parseCallout(block) {
  const lines = String(block).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const m = lines[0].match(CALLOUT_HEAD_RE);
  if (!m) return null;
  const type = m[1].toLowerCase();
  if (!CALLOUT_TYPES.includes(type)) return null;
  const rest = lines.slice(1);
  if (!rest.every((l) => l.startsWith('>'))) return null; // 块内混了非引用行
  const body = rest.map((l) => l.replace(/^>\s?/, '')).join(' ').trim();
  return { type, title: m[2].trim(), body };
}

// fix round(FR3):原实现不转义 ",但 esc() 被用在 HTML 属性上下文(title="..."/href="...")——
// H1 或链接里出现 ASCII 直引号(SKILL.md:166 明确要求金句用 ASCII 直引号,容易带偏模型在
// 全文含 H1 都用 "")会让属性值在第二个引号处提前闭合,后续 token 被解析成伪属性。
// & 必须先替换,否则 " → &quot; 产生的 & 会被二次转义成 &amp;quot;。
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tsToSec(label) {
  const p = String(label).split(':').map((x) => parseInt(x, 10));
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return NaN;
}

// 归一化:小写、去标点、压空白 —— 供 C3/C4 匹配前统一处理
function normalize(s) {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

// 金句匹配专用归一化:在 normalize 之上再去掉填充音、折叠连续重复词。
//
// 为什么需要(方案 D,2026-07-28 实证):C4 要求金句是 full_text 的精确子串,撰写约束
// 又写着"不得改写、不得润色" —— 两条叠加的必然产物是金句原样收录口语噪音,
// 实测产出过 "Um and the way we we look at things in my team is uh we don't trust anything."。
// 金句是这份产物的核心呈现物,可读性不该为防伪造买单。
//
// 两边(金句与转录)做同样处理,子串关系不变,所以防伪造能力一点不降:
// 删实词、改词序、整句编造依然不是子串,照样被 C4 拦下。
//
// 集合必须只收**无实词歧义**的填充音。like / actually / you know / basically / sort of
// 都承载语义,放进来等于给任意改写开后门 —— 见 T44。
const FILLER_RE = /\b(?:u+m+|u+h+|u+h+m+|e+r+m?|a+h+|h?mm+)\b/g;

function normalizeQuote(s) {
  return normalize(s)
    .replace(FILLER_RE, ' ')
    .replace(/\s+/g, ' ')
    // 折叠重复词放在去填充音之后:"we uh we" 先变 "we we",才折得掉
    .replace(/\b(\w+)(?: \1)+\b/g, '$1')
    .trim();
}

// token 重叠率:needle 的词在 hay 词集合中的命中比例,顺序无关。
// 仅供 C3 子串匹配失败后的宽松兜底(时间戳窗口内文本可能因分词切分错位导致子串不中)。
// fix round F8:needle 内重复词先去重再算比例 —— 不去重时,一句几乎全是高频功能词
// 的短语(如 "this is one of the things that that is..." )单靠重复计数就能虚高凑够 0.8,
// 是一条真实存在的假阴性带(评审密集 cue 压测:3714 组错配漏放 2 组)。
function tokenOverlapRatio(needle, hay) {
  const needleTokens = [...new Set(needle.split(' ').filter(Boolean))];
  if (needleTokens.length === 0) return 0;
  const hayTokens = new Set(hay.split(' ').filter(Boolean));
  const hit = needleTokens.filter((t) => hayTokens.has(t)).length;
  return hit / needleTokens.length;
}

// C3 窗口选段:在"start 落在 ±tolSec 区间"的基础上,额外纳入"覆盖 sec 的那一段"
// (start<=sec 中最后一段)及其紧邻后继段 —— 见 runChecks 内 fix round F6 注释。
// MAX_ADJACENT_GAP_SEC 界定"后继段仍算相邻",避免把窗口放宽到吞掉毫不相关的远处段落。
const MAX_ADJACENT_GAP_SEC = 70;
function windowSegmentsFor(segments, sec, tolSec) {
  const inRange = segments.filter((s) => s.start >= sec - tolSec && s.start <= sec + tolSec);
  const covering = segments
    .filter((s) => s.start <= sec && sec - s.start <= MAX_ADJACENT_GAP_SEC)
    .sort((a, b) => b.start - a.start)[0] || null;
  const extra = [];
  if (covering) {
    extra.push(covering);
    const idx = segments.indexOf(covering);
    const successor = idx >= 0 ? segments[idx + 1] : undefined;
    if (successor && successor.start - sec <= MAX_ADJACENT_GAP_SEC) extra.push(successor);
  }
  const seen = new Set();
  const result = [];
  for (const s of [...inRange, ...extra]) {
    if (!seen.has(s.start)) { seen.add(s.start); result.push(s); }
  }
  return result;
}

function parseTutorialMd(md) {
  const titleM = md.match(/^#\s+(.+)$/m);
  const title = titleM ? titleM[1].trim() : '';

  // 按二级标题切段:逐段定位,不做跨块全局正则
  const sections = {};
  const positions = [];
  for (const k of SECTION_KEYS) {
    const m = md.match(SECTION_HEADS[k]);
    positions.push({ key: k, idx: m ? m.index : -1 });
  }
  const present = positions.filter((p) => p.idx >= 0).sort((a, b) => a.idx - b.idx);
  for (let i = 0; i < present.length; i++) {
    const start = present[i].idx;
    const end = i + 1 < present.length ? present[i + 1].idx : md.length;
    const body = md.slice(start, end).replace(/^##[^\n]*\n/, '').trim();
    sections[present[i].key] = body;
  }
  for (const k of SECTION_KEYS) if (!(k in sections)) sections[k] = '';

  // 金句:> [mm:ss] "english"  \n > —— 中文
  const quotes = [];
  const qRe = /^>\s*\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*"([^"]+)"\s*\n>\s*——\s*(.+)$/gm;
  let m;
  while ((m = qRe.exec(sections.quotes || '')) !== null) {
    quotes.push({ label: m[1], sec: tsToSec(m[1]), en: m[2].trim(), zh: m[3].trim() });
  }

  // 方法论步骤(标题 + 正文)
  // fix round(FR1):原实现只捕获标题行,不捕获正文 —— C5 因此只能判"标题非空",
  // 判不了"正文是否空洞"。这里先收集每个标题整行的起止位置,再用"本标题行末尾"
  // 到"下一个标题行起始"(或段落末尾)切出该步的正文。
  const steps = [];
  const sRe = /^###\s*(\d+)[.、]\s*(.+)$/gm;
  const heads = [];
  while ((m = sRe.exec(sections.method || '')) !== null) {
    heads.push({ no: parseInt(m[1], 10), title: m[2].trim(), lineStart: m.index, lineEnd: m.index + m[0].length });
  }
  for (let i = 0; i < heads.length; i++) {
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].lineStart : (sections.method || '').length;
    steps.push({
      no: heads[i].no,
      title: heads[i].title,
      body: (sections.method || '').slice(heads[i].lineEnd, bodyEnd).trim(),
    });
  }

  return { title, sections, quotes, steps, raw: md };
}

// 数列表项条数(只计数不渲染)。除 `-`/`*` 外也认编号列表 `1.` / `1、`——SKILL.md 的撰写
// 约束并未禁止编号写法,若只认 bullet,一份内容完整的编号 TL;DR 会被 C1 判成"内容空洞"
// 而中止当天流水线,且报错文案会把 3 轮修复循环引向"重写内容"而非"换标记符"。
function countListItems(body) {
  return (body || '').split('\n')
    .filter((l) => /^(?:[-*]|\d+[.、])\s*(?:\[[ x]\]\s*)?.+/.test(l.trim())).length;
}

// C1/C5 内容深度阈值(FR1 —— 评审实测"结构合法、内容空洞"的骨架文档能通过旧版全部
// 自检:C1 原来只判段落 trim() 非空,C5 原来只判步骤数≥3 且标题非空,SKILL.md:163
// "每步须有标题和正文"这句里"正文"这一半完全没有脚本落地)。
// 阈值取自 tests/fixtures/tutorial-good.md 的真实实测值,不是凭空估的:
//   - 三步正文实测 22/27/24 字符 → STEP_BODY_MIN_CHARS=15(留安全余量,拦住 tutorial-hollow.md 的 0 字符空正文)
//   - TL;DR/checklist 均实测 3 条 → 阈值 2(留 1 条余量,拦住骨架文档的 1 条)
//   - 背景段实测 54 字符 → BACKGROUND_MIN_CHARS=30(评审建议的 60 反而会误杀这份合格夹具,未采纳)
//   - H1 实测 20 字符 → H1_MIN_CHARS=6(采纳评审建议,骨架文档标题"AI 教程"5 字符,刚好落在阈值下)
const STEP_BODY_MIN_CHARS = 15;
const TLDR_MIN_BULLETS = 2;
const CHECKLIST_MIN_ITEMS = 2;
const BACKGROUND_MIN_CHARS = 30;
const H1_MIN_CHARS = 6;

function runChecks(doc, transcript, selected) {
  const v = [];
  const add = (code, message) => v.push({ code, message });

  // C1 五段齐全 + 最小内容要求(FR1:拦"段落存在但内容空洞")
  for (const k of SECTION_KEYS) {
    if (!doc.sections[k] || doc.sections[k].trim().length === 0) add('C1', `缺少段落: ${k}`);
  }
  if (doc.sections.tldr) {
    const n = countListItems(doc.sections.tldr);
    if (n < TLDR_MIN_BULLETS) add('C1', `TL;DR 条目过少(${n} 条,要求 ≥${TLDR_MIN_BULLETS} 条),内容空洞${n === 0 ? ';若已写了条目请检查行首标记是否为 - / * / 1.' : ''}`);
  }
  if (doc.sections.checklist) {
    const n = countListItems(doc.sections.checklist);
    if (n < CHECKLIST_MIN_ITEMS) add('C1', `checklist 条目过少(${n} 条,要求 ≥${CHECKLIST_MIN_ITEMS} 条),内容空洞${n === 0 ? ';若已写了条目请检查行首标记是否为 - [ ] / - / 1.' : ''}`);
  }
  if (doc.sections.background && doc.sections.background.length < BACKGROUND_MIN_CHARS) {
    add('C1', `背景段落过短(${doc.sections.background.length} 字符,要求 ≥${BACKGROUND_MIN_CHARS} 字符),内容空洞`);
  }
  if (!doc.title) add('C1', '缺少 H1 标题');
  else if (doc.title.length < H1_MIN_CHARS) add('C1', `H1 标题过短(${doc.title.length} 字符,要求 ≥${H1_MIN_CHARS} 字符)`);

  // C2 时间戳格式合法且 ≤ 视频总时长上界
  // fix round(端到端验收缺陷2):duration_sec 来自 YouTube Data API 的
  // contentDetails.duration,segments 来自实际下载的字幕轴 —— 两个来源可能不一致
  // (实测 transcript-real.json:duration_sec=2480,但最后一段 start=2928,76 段里
  // 12 段(16%)超出 duration_sec;这份转录本身是真的,错的是 duration_sec 那个值)。
  // C2 的目的是拦荒谬的、编造的时间戳(如 [99:99]),不是拦真实字幕里存在的时间点,
  // 因此上界改取 duration_sec 与 segments 实际最大 start 中较大者,再加
  // SEGMENT_TAIL_MARGIN_SEC 余量 —— 该值取自 fetch-transcript.js 里
  // mergeSegments({maxSec:60}) 的 60s:最后一段自身的实际时长上限是 60s,
  // 时间戳落在"最后一段 start + 60s"以内仍可能是该段内的真实内容,不应被当成编造。
  const SEGMENT_TAIL_MARGIN_SEC = 60;
  const maxSegStart = (transcript.segments && transcript.segments.length > 0)
    ? Math.max(...transcript.segments.map((s) => s.start))
    : 0;
  const durationUpperBound = Math.max(transcript.duration_sec, maxSegStart) + SEGMENT_TAIL_MARGIN_SEC;
  for (const q of doc.quotes) {
    if (!Number.isFinite(q.sec)) { add('C2', `时间戳无法解析: ${q.label}`); continue; }
    if (q.sec > durationUpperBound) {
      add('C2', `时间戳 ${q.label}(${q.sec}s) 超过视频总时长上界 ${durationUpperBound}s`
        + `(取 duration_sec=${transcript.duration_sec} 与字幕最后一段 start=${maxSegStart}`
        + ` 中较大者 + ${SEGMENT_TAIL_MARGIN_SEC}s 余量)`);
    }
  }

  // C3 金句文本能在"时间戳窗口"覆盖到的 segment 文本里定位 —— 拦"真金句配错时间戳"
  // (fix round F1:原实现只比较 s.start 与 q.sec 的数值距离,完全不看文本,
  //  真金句配一个真实但错误的时间戳会被直接放行;真实字幕 cue 间距约 2-5s,
  //  按此密度模拟 2480s 时长几乎不存在"时间戳落空"的情况,C3 在真实数据上形同虚设)。
  // 窗口 ±10s:覆盖一句话可能跨 2-3 个 cue(cue 间距 2-5s)的情况,同时不宽到吞掉相邻无关句子。
  // fix round F6:生产环境 transcript 不是密集 cue —— fetch-transcript.js 的
  // mergeSegments({minSec:30,maxSec:60}) 把字幕合并成 30-60s 大段(transcript-real.json 实测
  // 段间距 31-62s)。金句常跨相邻两段:前半句在段末、后半句在下一段开头;AI 按惯例把时间戳写成
  // 该段自己的 startLabel 时,后半句所在的下一段会落在 ±10s 窗口外,导致真实金句被误判 C3
  // (评审用生产形态实测:75 组构造中 20 组误报,27%)。windowSegmentsFor 额外纳入"覆盖 sec 的段"
  // 及其紧邻后继段(见函数定义与 MAX_ADJACENT_GAP_SEC)来堵这个洞。
  const C3_WINDOW_SEC = 10;
  for (const q of doc.quotes) {
    if (!Number.isFinite(q.sec)) continue;
    const windowSegs = windowSegmentsFor(transcript.segments, q.sec, C3_WINDOW_SEC);
    const windowHay = normalizeQuote(windowSegs.map((s) => s.text).join(' '));
    const needle = normalizeQuote(q.en);
    const substringHit = windowHay.length > 0 && windowHay.includes(needle);
    // 子串不中时退到 token 重叠阈值,容忍窗口边界把长句切成两半导致的子串错位
    const overlapHit = !substringHit && tokenOverlapRatio(needle, windowHay) >= 0.8;
    if (!substringHit && !overlapHit) {
      add('C3', `时间戳 ${q.label} 附近(±${C3_WINDOW_SEC}s)找不到该金句文本: "${q.en}"`);
    }
  }

  // C4 英文金句能在 transcript 原文中检索到
  const hay = normalizeQuote(transcript.full_text);
  for (const q of doc.quotes) {
    const needle = normalizeQuote(q.en);
    if (needle.length < 8) { add('C4', `金句过短无法校验: "${q.en}"`); continue; }
    if (!hay.includes(needle)) add('C4', `金句在 transcript 中检索不到: "${q.en}"`);
  }
  if (doc.quotes.length === 0) add('C4', '未提供任何原声金句');

  // C4 补充:金句部分损坏被静默丢弃(端到端验收缺陷1)
  // qRe 只认 ASCII 直引号 "…",一条金句只要英文部分误用中文弯引号 "…" 就会从
  // doc.quotes 里彻底消失且不留痕迹 —— 旧实现只在"全部"金句都坏掉(上面的
  // doc.quotes.length===0)时才报错,5 条里坏 1 条这种部分丢失完全无感、exit 0 照常渲染。
  // 这里在原始 quotes 段落文本里数"看起来像金句行"(以 "> [mm:ss]" 开头)的数量,
  // 与实际解析出的条数比对 —— 不相等说明有金句行"看起来是金句但没解析出来",报违规,
  // 且报错要点名最常见成因(弯引号),否则 AI 的 3 轮修复循环会往错误方向猜。
  const quoteHeadRe = /^>\s*\[\d{1,3}:\d{2}(?::\d{2})?\]/;
  const quoteLikeLines = (doc.sections.quotes || '').split('\n')
    .filter((line) => quoteHeadRe.test(line.trim()));
  if (quoteLikeLines.length !== doc.quotes.length) {
    const suspects = quoteLikeLines.filter((line) => !/"[^"]+"/.test(line));
    const hint = suspects.length > 0
      ? `疑似原因:以下行未使用 ASCII 直引号 "…"(很可能误用了中文弯引号 “…”): `
        + suspects.map((line) => line.trim()).join(' | ')
      : '疑似原因:金句缺少下一行的 "> —— 中文译文",或格式与 `> [mm:ss] "english"` 不完全匹配。';
    add('C4', `原声金句部分丢失:段落中有 ${quoteLikeLines.length} 行疑似金句(以 "> [mm:ss]" 开头),`
      + `但只成功解析出 ${doc.quotes.length} 条。${hint}`);
  }

  // C5 方法论 ≥3 步、标题非空、且每步正文非空洞(FR1:原实现不检查正文,只检查标题)
  if (doc.steps.length < 3) add('C5', `方法论步骤仅 ${doc.steps.length} 个,要求 ≥3`);
  for (const s of doc.steps) {
    if (!s.title) add('C5', `第 ${s.no} 步标题为空`);
    if (!s.body || s.body.length < STEP_BODY_MIN_CHARS) {
      add('C5', `第 ${s.no} 步正文过短或缺失(${s.body ? s.body.length : 0} 字符,要求 ≥${STEP_BODY_MIN_CHARS} 字符),仅有标题无实质内容`);
    }
  }

  // C6 无占位符 + 正文无非法 `>` 标记
  const ph = doc.raw.match(PLACEHOLDER_RE);
  if (ph) add('C6', `存在占位符: ${ph[0]}`);

  const allowed = CALLOUT_TYPES.map((t) => `[!${t}]`).join(' / ');
  for (const key of ['tldr', 'background', 'method', 'checklist']) {
    for (const block of (doc.sections[key] || '').split(/\n{2,}/)) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.some((l) => l.startsWith('>'))) continue;
      if (parseCallout(block)) continue;

      const headIdx = lines.findIndex((l) => CALLOUT_HEAD_RE.test(l));
      if (headIdx > 0) {
        add('C6', `${key} 段的 callout 没有独立成段:\`${lines[headIdx].slice(0, 40)}\` 前面必须空一行 `
          + `(前后各留一个空行),否则会和上文并成一个普通段落。允许的类型: ${allowed}`);
        continue;
      }
      const bad = lines[0].match(/^>\s*\[!([a-zA-Z]+)\]/);
      if (bad) {
        add('C6', `${key} 段使用了不支持的 callout 类型 [!${bad[1]}],正文只允许 ${allowed}`);
      } else {
        add('C6', `${key} 段出现裸 \`>\` 引用行(渲染层不支持,会显示成 &gt; 破版): `
          + `"${lines[0].slice(0, 50)}";需要强调请改用 ${allowed},或直接写成普通段落`);
      }
    }
  }

  // C7 与 selected.json 一致
  if (transcript.video_id !== selected.id) {
    add('C7', `transcript.video_id(${transcript.video_id}) 与 selected.id(${selected.id}) 不一致`);
  }

  // C8 正文段落无未翻译的成段英文(金句区豁免)
  // fix round F3:原实现按 \n 分行、整行含任意中文字符即豁免整行 —— 中英文写在同一段落/同一行时
  // (常见于 AI 输出的连续段落),一句夹在中文句子后面的未翻译英文会被前面的中文"连带豁免",
  // 检测形同虚设。改为先按行取出,再按句终止符(。！？.!?)切成句子,逐句独立判定。
  // fix round F5(F3 引入的回归):句级判定把长度阈值也从"整行"降到了"每句",导致
  // "整行纯英文、但拆成的每句都 <40 字符"这种输入被放行(旧的行级判定本能拦住)。
  // 改为先做行级判定(整行 ≥40 字符且纯 ASCII 无中文即报),行级不中时再退到句级判定
  // (句级专门负责"中英文同行"场景) —— 两级取并集,不是互斥。
  const bodyKeys = ['tldr', 'background', 'method', 'checklist'];
  const isUntranslatedAscii = (s) => s.length >= 40 && !/[一-鿿]/.test(s)
    && /^[A-Za-z0-9\s,.'"()\-:;/&%$#@!?]+$/.test(s);
  for (const k of bodyKeys) {
    for (const line of (doc.sections[k] || '').split('\n')) {
      const t = line.replace(/^[-*>\s\[\]x]+/, '').trim();
      if (!t) continue;
      if (isUntranslatedAscii(t)) {
        add('C8', `${k} 段存在未翻译的成段英文: "${t.slice(0, 60)}…"`);
        continue; // 整行已判定,不再重复对句子级判定(避免同一处内容报两条)
      }
      const sentences = t.split(/(?<=[。！？.!?])\s*/).map((s) => s.trim()).filter(Boolean);
      for (const s of sentences) {
        if (isUntranslatedAscii(s)) {
          add('C8', `${k} 段存在未翻译的成段英文: "${s.slice(0, 60)}…"`);
        }
      }
    }
  }

  return v;
}

// ---- 渲染(逐单元构建) --------------------------------------------------

function mdInlineToHtml(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderList(body, { check = false } = {}) {
  const items = body.split('\n')
    .map((l) => l.match(/^[-*]\s*(?:\[[ x]\]\s*)?(.+)$/))
    .filter(Boolean)
    .map((m) => `<li>${mdInlineToHtml(m[1])}</li>`);
  if (items.length === 0) return `<p>${mdInlineToHtml(body)}</p>`;
  return `<ul${check ? ' class="check"' : ''}>\n${items.join('\n')}\n</ul>`;
}

function renderCallout({ type, title, body }) {
  const head = title ? `<div class="callout-t">${mdInlineToHtml(title)}</div>` : '';
  return `<div class="callout callout-${type}">${head}<p>${mdInlineToHtml(body)}</p></div>`;
}

function renderParagraphs(body) {
  return body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => {
      const callout = parseCallout(p);
      if (callout) return renderCallout(callout);
      return `<p>${mdInlineToHtml(p.replace(/\n/g, ' '))}</p>`;
    }).join('\n');
}

function renderMethod(body) {
  const out = [];
  const parts = body.split(/^###\s*/m).map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const head = nl < 0 ? part : part.slice(0, nl);
    const rest = nl < 0 ? '' : part.slice(nl + 1).trim();
    out.push(`<h3>${mdInlineToHtml(head)}</h3>`);
    if (rest) out.push(renderParagraphs(rest));
  }
  return out.join('\n');
}

function renderQuotes(quotes, videoId) {
  return quotes.map((q) => {
    const link = `https://www.youtube.com/watch?v=${videoId}&t=${q.sec}s`;
    return [
      '<blockquote>',
      `  <span class="en"><a class="ts" href="${link}">[${esc(q.label)}]</a> "${esc(q.en)}"</span>`,
      `  <span class="zh">—— ${mdInlineToHtml(q.zh)}</span>`,
      '</blockquote>',
    ].join('\n');
  }).join('\n');
}

function renderHtml(doc, selected, template) {
  const vid = selected.id;
  const meta = [
    esc(selected.channelTitle),
    esc(selected.channelHandle || ''),
    `${Math.round((selected.durationSec || 0) / 60)} 分钟`,
    `<a href="${esc(selected.url)}">原视频</a>`,
  ].filter(Boolean).join(' · ');

  const units = {
    '<!--TITLE-->': esc(doc.title),
    '<!--META-->': meta,
    '<!--TLDR-->': renderList(doc.sections.tldr),
    '<!--BACKGROUND-->': renderParagraphs(doc.sections.background),
    '<!--METHOD-->': renderMethod(doc.sections.method),
    '<!--CHECKLIST-->': renderList(doc.sections.checklist, { check: true }),
    '<!--QUOTES-->': renderQuotes(doc.quotes, vid),
    '<!--EMBED-->': `<iframe src="https://www.youtube.com/embed/${esc(vid)}" `
      + `title="${esc(doc.title)}" allowfullscreen loading="lazy"></iframe>`,
    '<!--FOOTER-->': `由 ai-talk-tutorial 自动生成 · 内容提炼自 ${esc(selected.channelTitle)} 的公开演讲`,
  };

  let out = template;
  for (const [anchor, html] of Object.entries(units)) {
    // 逐单元替换,split/join 避免 $& 等替换串特殊字符被解释
    out = out.split(anchor).join(html);
  }
  const leftover = out.match(/<!--[A-Z_]+-->/g);
  if (leftover) throw new Error(`模板锚点未替换: ${leftover.join(', ')}`);
  return out;
}

// ---- CLI ---------------------------------------------------------------

function usage() {
  return [
    'Usage: build-html.js --md <path> --transcript <path> --selected <path> --out <path>',
    '',
    'Exit: 0=通过 1=参数错 5=自检失败(不写 HTML)',
  ].join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const args = { md: null, transcript: null, selected: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--md': args.md = argv[++i]; break;
      case '--transcript': args.transcript = argv[++i]; break;
      case '--selected': args.selected = argv[++i]; break;
      case '--out': args.out = argv[++i]; break;
      case '-h': case '--help': process.stdout.write(usage() + '\n'); process.exit(0);
      default:
        process.stderr.write(`Unknown flag: ${argv[i]}\n${usage()}\n`);
        process.exit(1);
    }
  }
  for (const k of ['md', 'transcript', 'selected', 'out']) {
    if (!args[k]) {
      process.stderr.write(`--${k} is required\n` + usage() + '\n');
      process.exit(1);
    }
  }

  const doc = parseTutorialMd(fs.readFileSync(args.md, 'utf-8'));
  const transcript = JSON.parse(fs.readFileSync(args.transcript, 'utf-8'));
  const selected = JSON.parse(fs.readFileSync(args.selected, 'utf-8'));

  const violations = runChecks(doc, transcript, selected);
  if (violations.length > 0) {
    process.stderr.write(`自检未通过,共 ${violations.length} 条:\n`);
    for (const x of violations) process.stderr.write(`  [${x.code}] ${x.message}\n`);
    // fix round(FR4):$WORK 按 DATE 分目录,同日重跑(cron 重试/3 轮自检失败后人工重跑)
    // 会命中同一个 --out 路径。若不删除旧文件,Step 5 的 cp 会把上一次成功产出的陈旧
    // HTML 当作今日产出归档并广播,"3 轮不过则中止"退化成纯提示词约束(违反物理断路原则)。
    fs.rmSync(args.out, { force: true });
    process.stderr.write('HTML 未生成 —— 请修正 tutorial.md 后重跑\n');
    process.exit(5);
  }

  const tpl = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'tutorial.html'), 'utf-8'
  );
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, renderHtml(doc, selected, tpl));
  process.stderr.write(`自检 C1-C8 全通过 → ${args.out}\n`);
  process.exit(0);
}

module.exports = {
  parseTutorialMd, runChecks, renderHtml, normalize, normalizeQuote, tsToSec,
  parseCallout, CALLOUT_TYPES,
};

if (require.main === module) main();
