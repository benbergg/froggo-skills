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
const PLACEHOLDER_RE = /\b(TBD|TODO|FIXME|XXX|待补充|占位)\b/i;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tsToSec(label) {
  const p = String(label).split(':').map((x) => parseInt(x, 10));
  if (p.length === 2) return p[0] * 60 + p[1];
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  return NaN;
}

// 归一化:小写、去标点、压空白 —— 用于 C4 的模糊匹配
function normalize(s) {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
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

  // C3 时间戳在 transcript 中真实存在(±5s)
  const TOL = 5;
  for (const q of doc.quotes) {
    if (!Number.isFinite(q.sec)) continue;
    const hit = transcript.segments.some((s) => Math.abs(s.start - q.sec) <= TOL);
    if (!hit) add('C3', `时间戳 ${q.label} 在 transcript 中不存在(±${TOL}s 内无段落)`);
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
  const bodyKeys = ['tldr', 'background', 'method', 'checklist'];
  for (const k of bodyKeys) {
    for (const line of (doc.sections[k] || '').split('\n')) {
      const t = line.replace(/^[-*>\s\[\]x]+/, '').trim();
      if (t.length < 40) continue;
      if (/[一-鿿]/.test(t)) continue;          // 含中文即视为已翻译
      if (/^[A-Za-z0-9\s,.'"()\-:;/&%$#@!?]+$/.test(t)) {
        add('C8', `${k} 段存在未翻译的成段英文: "${t.slice(0, 60)}…"`);
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
