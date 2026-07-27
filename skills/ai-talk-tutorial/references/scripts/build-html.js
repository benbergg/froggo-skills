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

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  // 方法论步骤
  const steps = [];
  const sRe = /^###\s*(\d+)[.、]\s*(.+)$/gm;
  while ((m = sRe.exec(sections.method || '')) !== null) {
    steps.push({ no: parseInt(m[1], 10), title: m[2].trim() });
  }

  return { title, sections, quotes, steps, raw: md };
}

function runChecks(doc, transcript, selected) {
  const v = [];
  const add = (code, message) => v.push({ code, message });

  // C1 五段齐全
  for (const k of SECTION_KEYS) {
    if (!doc.sections[k] || doc.sections[k].trim().length === 0) add('C1', `缺少段落: ${k}`);
  }
  if (!doc.title) add('C1', '缺少 H1 标题');

  // C2 时间戳格式合法且 ≤ 视频总时长
  for (const q of doc.quotes) {
    if (!Number.isFinite(q.sec)) { add('C2', `时间戳无法解析: ${q.label}`); continue; }
    if (q.sec > transcript.duration_sec) {
      add('C2', `时间戳 ${q.label}(${q.sec}s) 超过视频总时长 ${transcript.duration_sec}s`);
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
    const windowHay = normalize(windowSegs.map((s) => s.text).join(' '));
    const needle = normalize(q.en);
    const substringHit = windowHay.length > 0 && windowHay.includes(needle);
    // 子串不中时退到 token 重叠阈值,容忍窗口边界把长句切成两半导致的子串错位
    const overlapHit = !substringHit && tokenOverlapRatio(needle, windowHay) >= 0.8;
    if (!substringHit && !overlapHit) {
      add('C3', `时间戳 ${q.label} 附近(±${C3_WINDOW_SEC}s)找不到该金句文本: "${q.en}"`);
    }
  }

  // C4 英文金句能在 transcript 原文中检索到
  const hay = normalize(transcript.full_text);
  for (const q of doc.quotes) {
    const needle = normalize(q.en);
    if (needle.length < 8) { add('C4', `金句过短无法校验: "${q.en}"`); continue; }
    if (!hay.includes(needle)) add('C4', `金句在 transcript 中检索不到: "${q.en}"`);
  }
  if (doc.quotes.length === 0) add('C4', '未提供任何原声金句');

  // C5 方法论 ≥3 步且无空步骤
  if (doc.steps.length < 3) add('C5', `方法论步骤仅 ${doc.steps.length} 个,要求 ≥3`);
  for (const s of doc.steps) {
    if (!s.title) add('C5', `第 ${s.no} 步标题为空`);
  }

  // C6 无占位符
  const ph = doc.raw.match(PLACEHOLDER_RE);
  if (ph) add('C6', `存在占位符: ${ph[0]}`);

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

function renderParagraphs(body) {
  return body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${mdInlineToHtml(p.replace(/\n/g, ' '))}</p>`).join('\n');
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

module.exports = { parseTutorialMd, runChecks, renderHtml, normalize, tsToSec };

if (require.main === module) main();
