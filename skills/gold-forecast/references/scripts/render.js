#!/usr/bin/env node
'use strict';
// 校验通过的预测 md → 归档用的 HTML + Markdown 双份产物。
//
// 两条业务规则必须 HTML 与 md 一致(设计 §8 把 .md 定位为归档件):
//   1. by_horizon[k].insufficient_sample 时不呈现该周期的胜率与 Brier;
//      短周期不足时连第五段的统计叙述一并撤下 —— 那段叙述的抬头数字正是短周期胜率。
//   2. review_triggers 非空时插入「定向复核」区块。
//
// 退出码:0=成功 1=参数错

const fs = require('node:fs');
const path = require('node:path');
const { parseForecast } = require('./forecast-parser');
const { DISCLAIMER_TEXT } = require('./lib/disclaimer');
const { atomicWriteText } = require('./lib/atomic-write');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'report.html');

const SECTIONS = [
  { num: '一', id: 'conclusion', title: '今日结论' },
  { num: '二', id: 'facts', title: '市场事实' },
  { num: '三', id: 'counterparty', title: '对手盘结构' },
  { num: '四', id: 'reasoning', title: '判断依据' },
  { num: '五', id: 'review', title: '上期结算与反思' },
  { num: '六', id: 'howto', title: '如何使用本区间' },
  { num: '七', id: 'disclaimer', title: '免责声明' },
];
const HORIZONS = ['short', 'medium', 'long'];
const HORIZON_LABEL = { short: '短期', medium: '中期', long: '长期' };
const BAND_LABEL = { short: '短', medium: '中', long: '长' };
const TRIGGER_LABEL = {
  final_worse_than_baseline: '最终模型连续 3 期劣于基线',
  confidence_inversion: '高置信档胜率倒挂',
  lesson_ineffective: '教训连续无效',
  c9_high_rate: 'C9 自检触发率超阈值',
};

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 归档要躺很多年,注入的脚本会一直在 —— 协议白名单不可省。
function safeUrl(u) {
  try {
    const p = new URL(String(u));
    return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : null;
  } catch { return null; }
}

// ---- markdown → HTML 的最小转换 -----------------------------------------
// 顺序死规矩:先 escapeHtml 原文本,再用标记生成标签。反过来会把自己生成的标签
// 也转义成文本,页面上出现一堆 &lt;li&gt;。

// markdown 链接与裸 URL 一次扫完:分两遍做的话,第二遍会撞进第一遍生成的 href="…" 里。
// 全角标点排除在 URL 之外,否则紧跟 URL 的中文句读会被吃进链接。
const LINK_RE_SRC = /\[([^\]\n]+)\]\(([^)\s]*)\)|[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>"'()（），。、；：！？【】「」]+/;

// escapeHtml 已经跑过,此刻 `"` `'` 是 &quot; / &#39; —— 组成它们的字符都在放行集内,
// 裸 URL 会一路吞下去,href 里出现转义实体。故在这些实体处截断。
const ENTITY_STOP = /&quot;|&#39;|&lt;|&gt;/;

const emphasis = (s) => s
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

// 强调标记只作用于链接之外的文本与链接文字,绝不进 href ——
// 顺序反过来会把 <code> 注入 href(实测 `[x](https://a/?q=\`y\`)`),链接直接失效。
function inline(s) {
  const src = escapeHtml(s);
  // 每次新建:带 g 的模块级正则在 exec 循环里会跨调用串 lastIndex
  const re = new RegExp(LINK_RE_SRC.source, 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    out += emphasis(src.slice(last, m.index));
    const isMd = m[1] !== undefined;
    const url = isMd ? m[2] : m[0].split(ENTITY_STOP)[0];
    // &amp; 还原成 &:query 里的合法分隔符,不还原会让 href 指向错误地址
    const href = safeUrl(url.replace(/&amp;/g, '&'));
    const label = emphasis(isMd ? m[1] : url);
    // 协议不过关时连 URL 字面量一起丢掉,只留文字
    out += href ? `<a href="${escapeHtml(href)}" rel="noopener nofollow">${label}</a>` : label;
    // 裸 URL 被实体截短时,剩下的部分退回普通文本重新扫
    last = m.index + (isMd ? m[0].length : (url.length || m[0].length));
    re.lastIndex = last;
  }
  return out + emphasis(src.slice(last));
}

const LIST_RE = /^(?:[-*]|\d+[.、])\s+(.+)$/;

function parseList(block) {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  const items = lines.map((l) => l.match(LIST_RE));
  return items.every(Boolean) ? items.map((m) => m[1]) : null;
}

function parseTable(block) {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || !lines.every((l) => l.startsWith('|'))) return null;
  const cells = (l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const sep = cells(lines[1]);
  if (!sep.length || !sep.every((c) => /^:?-{2,}:?$/.test(c))) return null;
  return { head: cells(lines[0]), rows: lines.slice(2).map(cells) };
}

function renderTable({ head, rows }) {
  const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('\n');
  return `<div class="tw"><table class="dt">\n<thead><tr>${th}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`;
}

function renderBlocks(text) {
  return String(text || '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
    .map((b) => {
      const t = parseTable(b);
      if (t) return renderTable(t);
      const l = parseList(b);
      if (l) return `<ul>\n${l.map((it) => `<li>${inline(it)}</li>`).join('\n')}\n</ul>`;
      return `<p>${inline(b.replace(/\n/g, ' '))}</p>`;
    }).join('\n');
}

// ---- 内联 SVG ------------------------------------------------------------
// 不引外部库、不引外部资源:归档件在离线环境和多年以后都得画得出来。

const fmt = (n) => Number(n).toFixed(1);

// Number(null) 与 Number('') 都是 0 且 isFinite,直接 map(Number).filter(isFinite)
// 等于把「这期没有数据」画成「这期的值是 0」—— Brier 图上就是基线从完美的 0 起步,
// 价格图上就是折线一头扎到底。null 是 brier_series 与 history 的契约内正常产出,
// 渲染层是归档件的最后一道,不该指望上游过滤得干净。
function finiteNum(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return NaN;
  if (String(v).trim() === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// points 为纯数值序列;bands 画在折线右侧的预留区(未来三期),refs 为贯穿全宽的参考线。
function sparkline(points, { width = 640, height = 160, band = null, bands = [], refs = [], plotRatio = null } = {}) {
  const pts = (points || []).map(finiteNum).filter(Number.isFinite);
  const boxes = (band ? [{ key: 'band', low: band.low, high: band.high }] : [])
    .concat(bands || []).filter((b) => b && Number.isFinite(b.low) && Number.isFinite(b.high));
  const refVals = (refs || []).filter((r) => Number.isFinite(r.value));
  if (!pts.length && !boxes.length) return '<svg width="0" height="0"></svg>';

  const all = pts.concat(boxes.flatMap((b) => [b.low, b.high]), refVals.map((r) => r.value));
  const raw = { lo: Math.min(...all), hi: Math.max(...all) };
  // 留 6% 余量:折线顶到边框会读不出走势,区间带上沿贴边会看不出是个带
  const pad = (raw.hi - raw.lo) * 0.06 || 1;
  const lo = raw.lo - pad;
  const hi = raw.hi + pad;
  const ratio = plotRatio === null ? (boxes.length ? 0.55 : 1) : plotRatio;
  const plotW = width * ratio;
  const x = (i) => (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * plotW);
  const y = (v) => height - ((v - lo) / Math.max(1e-9, hi - lo)) * height;

  const out = [];
  for (const r of refVals) {
    out.push(`<line class="${escapeHtml(r.cls || 'ref')}" x1="0" y1="${fmt(y(r.value))}" x2="${fmt(width)}" y2="${fmt(y(r.value))}"/>`);
  }
  const slot = boxes.length ? (width - plotW) / boxes.length : 0;
  boxes.forEach((b, i) => {
    const bx = plotW + slot * i + slot * 0.16;
    const bw = Math.max(2, slot * 0.68);
    const top = y(b.high);
    out.push(`<rect class="band" data-h="${escapeHtml(b.key)}" x="${fmt(bx)}" y="${fmt(top)}"`
      + ` width="${fmt(bw)}" height="${fmt(Math.max(1, y(b.low) - top))}"/>`);
    if (b.label) out.push(`<text class="band-lbl" x="${fmt(bx + bw / 2)}" y="${fmt(height)}">${escapeHtml(b.label)}</text>`);
  });
  if (pts.length) {
    const d = pts.map((v, i) => `${i ? 'L' : 'M'}${fmt(x(i))},${fmt(y(v))}`).join('');
    out.push(`<path class="pl" d="${d}" fill="none" stroke="currentColor" stroke-width="1.6"/>`);
    out.push(`<circle class="dot" cx="${fmt(x(pts.length - 1))}" cy="${fmt(y(pts[pts.length - 1]))}" r="3"/>`);
  }
  out.push(`<text class="axis-lbl" x="0" y="11">${escapeHtml(raw.hi.toFixed(1))}</text>`);
  out.push(`<text class="axis-lbl" x="0" y="${fmt(height - 2)}">${escapeHtml(raw.lo.toFixed(1))}</text>`);
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">`
    + out.join('') + '</svg>';
}

// 三期区间取自 doc.json.horizons(三期恒全);baseline 只做 short 的参考线 ——
// baseline.horizons 在真实产物里也只有它是被逐日校准过的对照。
function priceChart({ history, horizons, baseline }) {
  const pts = (history || []).map((r) => finiteNum(r && r.value));
  const bands = HORIZONS
    .filter((k) => horizons[k] && Number.isFinite(horizons[k].low) && Number.isFinite(horizons[k].high))
    .map((k) => ({ key: k, low: horizons[k].low, high: horizons[k].high, label: BAND_LABEL[k] }));
  const refs = [];
  const bs = baseline && baseline.horizons && baseline.horizons.short;
  if (baseline && Number.isFinite(baseline.base_price)) refs.push({ value: baseline.base_price, cls: 'ref ref-base' });
  if (bs && Number.isFinite(bs.low)) refs.push({ value: bs.low, cls: 'ref' });
  if (bs && Number.isFinite(bs.high)) refs.push({ value: bs.high, cls: 'ref' });
  const svg = sparkline(pts, { bands, refs, height: 180 });
  if (!bands.length && !pts.length) return '';
  return `<figure class="chart">${svg}`
    + '<figcaption>左侧为伦敦金定盘价近期走势,右侧三条色带为本期短/中/长期预测区间;'
    + '虚线为量化基线的短期区间,细实线为基准定盘价。</figcaption></figure>';
}

// 累积均值序列,三方各一条线。拿三个聚合标量连成折线冒充「演化」比画不出来更糟:
// 读者会把三点折线当趋势记住。故序列拿不到就留白。
function brierChart(series, { width = 640, height = 160 } = {}) {
  const rows = Array.isArray(series) ? series : [];
  if (rows.length < 2) return '';
  const keys = ['final', 'baseline', 'naive'];
  const all = rows.flatMap((p) => keys.map((k) => finiteNum(p[k]))).filter(Number.isFinite);
  if (!all.length) return '';
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = (hi - lo) * 0.12 || 0.01;
  const x = (i) => (rows.length <= 1 ? 0 : (i / (rows.length - 1)) * width);
  const y = (v) => height - ((v - (lo - pad)) / Math.max(1e-9, (hi + pad) - (lo - pad))) * height;
  const paths = keys.map((k) => {
    let started = false;
    const d = rows.map((p, i) => {
      const v = finiteNum(p[k]);
      if (!Number.isFinite(v)) return '';
      const cmd = started ? 'L' : 'M';
      started = true;
      return `${cmd}${fmt(x(i))},${fmt(y(v))}`;
    }).join('');
    return d ? `<path class="ln ln-${k}" d="${d}"/>` : '';
  }).filter(Boolean).join('');
  const axis = `<text class="axis-lbl" x="0" y="11">${escapeHtml(hi.toFixed(4))}</text>`
    + `<text class="axis-lbl" x="0" y="${fmt(height - 2)}">${escapeHtml(lo.toFixed(4))}</text>`;
  return '<figure class="chart">'
    + `<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">${paths}${axis}</svg>`
    + `<div class="lg">短周期 · — 最终模型 &nbsp; — 量化基线 &nbsp; -- 朴素基准 &nbsp;(${rows.length} 期累积均值)</div>`
    + '<figcaption>Brier 越低越好。画累积均值而非逐条值:逐条 Brier 抖动太大,'
    + '「随样本累积谁在赢」才是这张图要回答的问题。</figcaption></figure>';
}

// ---- 记分卡与定向复核 ---------------------------------------------------

const pct = (x) => `${(Number(x) * 100).toFixed(1)}%`;
const num = (x, d = 4) => (Number.isFinite(x) ? Number(x).toFixed(d) : '—');

function triggerParts(t) {
  const parts = [TRIGGER_LABEL[t.kind] || String(t.kind)];
  if (t.horizon) parts.push(`周期 ${HORIZON_LABEL[t.horizon] || t.horizon}`);
  if (Array.isArray(t.ids) && t.ids.length) parts.push(`相关期次 ${t.ids.join('、')}`);
  if (Number.isFinite(t.rate)) parts.push(`触发率 ${pct(t.rate)}`);
  if (t.lesson_id) parts.push(`教训 ${t.lesson_id}`);
  if (Number.isFinite(t.trials)) parts.push(`已检验 ${t.trials} 次`);
  if (Number.isFinite(t.gt65) && Number.isFinite(t.lt55)) {
    parts.push(`高置信 ${pct(t.gt65)} 低于低置信 ${pct(t.lt55)}`);
  }
  return parts;
}

const REVIEW_NOTE = '以上为记分卡自动触发项,需在本段正文中逐条给出解释或修正方向。';

function reviewBlockHtml(triggers) {
  const ts = Array.isArray(triggers) ? triggers : [];
  if (!ts.length) return '';
  const li = ts.map((t) => {
    const p = triggerParts(t);
    return `<li><strong>${escapeHtml(p[0])}</strong>${p.slice(1).map((s) => ` · ${escapeHtml(s)}`).join('')}</li>`;
  }).join('\n');
  return `<div class="review-alert"><div class="review-h">定向复核</div>\n<ul>\n${li}\n</ul>\n`
    + `<p class="review-note">${escapeHtml(REVIEW_NOTE)}</p></div>`;
}

function reviewBlockMd(triggers) {
  const ts = Array.isArray(triggers) ? triggers : [];
  if (!ts.length) return '';
  return ['### 定向复核', '',
    ...ts.map((t) => `- ${triggerParts(t).join(' · ')}`),
    '', REVIEW_NOTE].join('\n');
}

const INSUFFICIENT_CELL = (n) => `样本不足(已结算 ${n} 期),本期不呈现胜率与 Brier 对照`;
const WITHHELD_NOTE = '短周期样本不足,本段的胜率、Brier 与 Winkler 叙述不予呈现,勿据此调整策略;'
  + '待样本累积到位后自动恢复。';

function presentHorizons(byHorizon) {
  const bh = byHorizon || {};
  return HORIZONS.filter((k) => bh[k]).map((k) => ({ key: k, stat: bh[k] }));
}

const HEAD = ['周期', '样本', '方向胜率', '最终 Brier', '基线 Brier', '朴素 Brier', '最终 Winkler'];

function scoreRow({ key, stat }) {
  const label = HORIZON_LABEL[key] || key;
  if (stat.insufficient_sample) return [label, String(stat.n ?? '—'), INSUFFICIENT_CELL(stat.n ?? 0)];
  const f = stat.final || {};
  return [label, String(stat.n ?? '—'),
    Number.isFinite(f.dir_rate) ? pct(f.dir_rate) : '—',
    num(f.brier), num((stat.baseline || {}).brier), num((stat.naive || {}).brier), num(f.winkler, 1)];
}

function scorecardHtml(byHorizon) {
  const rows = presentHorizons(byHorizon);
  if (!rows.length) return '';
  const th = HEAD.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const body = rows.map((r) => {
    const cells = scoreRow(r);
    // 样本不足的行只有三格,末格横跨其余列 —— 数字位留空比填「—」更难被误读成 0
    const tds = cells.map((c, i) => {
      const span = (cells.length < HEAD.length && i === cells.length - 1) ? ` colspan="${HEAD.length - cells.length + 1}"` : '';
      const cls = i >= 2 && cells.length === HEAD.length ? ' class="num"' : '';
      return `<td${cls}${span}>${escapeHtml(c)}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('\n');
  return `<div class="tw"><table class="dt">\n<thead><tr>${th}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`;
}

function scorecardMd(byHorizon) {
  const rows = presentHorizons(byHorizon);
  if (!rows.length) return '';
  const line = (cs) => `| ${cs.join(' | ')} |`;
  return [line(HEAD), line(HEAD.map(() => '---')),
    ...rows.map((r) => {
      const cells = scoreRow(r);
      while (cells.length < HEAD.length) cells.push('');
      return line(cells);
    })].join('\n');
}

// ---- 组装 ---------------------------------------------------------------

function reportDate({ baseline, settlement }) {
  const h = (settlement && settlement.history) || [];
  return (baseline && baseline.base_date)
    || (settlement && settlement.latest && settlement.latest.date)
    || (h.length ? h[h.length - 1].date : '')
    || '';
}

function sectionText(doc, num, { withhold }) {
  if (num === '五' && withhold) return null;      // 抑制由调用方渲染成提示块
  if (num === '七') return doc.sections['七'] || DISCLAIMER_TEXT;
  return doc.sections[num] || '';
}

function renderReport({ doc, scorecard = {}, baseline = null, settlement = null }) {
  const byHorizon = scorecard.by_horizon || {};
  // 抑制锚定短周期:medium/long 天然晚 5/20 个交易日到达,用「任一周期不足」会把
  // 第五段整段封掉好几周,而短周期胜率正是这段叙述的抬头数字。
  const withhold = Boolean(byHorizon.short && byHorizon.short.insufficient_sample);
  const date = reportDate({ baseline, settlement });
  const title = `黄金交易预测 · ${date || '未标注日期'}`;
  const series = (byHorizon.short && byHorizon.short.brier_series) || null;

  const units = {
    '<!--TITLE-->': escapeHtml(title),
    '<!--DATE-->': escapeHtml(`基准交易日 ${date || '—'} · 本报告为自动生成的归档件`),
    '<!--CHART_PRICE-->': priceChart({
      history: (settlement && settlement.history) || [],
      horizons: (doc.json && doc.json.horizons) || {},
      baseline,
    }),
    '<!--CHART_BRIER-->': brierChart(series),
    '<!--REVIEW_BLOCK-->': reviewBlockHtml(scorecard.review_triggers),
    '<!--SCORECARD-->': scorecardHtml(byHorizon),
    '<!--FOOTER-->': escapeHtml('由 gold-forecast 自动生成 · 数据源 LBMA / FRED / CFTC · 归档留存'),
  };
  SECTIONS.forEach((s, i) => {
    units[`<!--H2_${i + 1}-->`] = escapeHtml(doc.headings[s.num] || s.title);
    const text = sectionText(doc, s.num, { withhold });
    units[`<!--S${i + 1}-->`] = text === null
      ? `<p class="withheld">${escapeHtml(WITHHELD_NOTE)}</p>`
      : renderBlocks(text);
  });

  let html = fs.readFileSync(TEMPLATE, 'utf-8');
  for (const [anchor, frag] of Object.entries(units)) {
    // split/join 而非 replace:替换串里的 $& 等会被 replace 当特殊记法解释
    html = html.split(anchor).join(frag);
  }
  const leftover = html.match(/<!--[A-Z0-9_]+-->/g);
  if (leftover) throw new Error(`模板锚点未替换: ${leftover.join(', ')}`);

  const md = [`# ${title}`, '', `> 基准交易日 ${date || '—'} · 自动生成的归档件`, ''];
  SECTIONS.forEach((s, i) => {
    md.push(`## ${s.num}、${doc.headings[s.num] || s.title}`, '');
    if (i === 4) {
      const rb = reviewBlockMd(scorecard.review_triggers);
      if (rb) md.push(rb, '');
      const sc = scorecardMd(byHorizon);
      if (sc) md.push(sc, '');
    }
    const text = sectionText(doc, s.num, { withhold });
    md.push(text === null ? WITHHELD_NOTE : text, '');
  });

  return { html, md: md.join('\n') };
}

// ---- CLI ---------------------------------------------------------------

function usage() {
  return [
    'Usage: render.js --forecast <md> --scorecard <json> --baseline <json>',
    '                 --settlement <json> --out-html <path> --out-md <path>',
    '',
    '--settlement 指向 collect-settlement.js 的产物,其 history 是定盘价走势图的唯一数据源。',
    '',
    'Exit: 0=成功 1=参数错',
  ].join('\n');
}

const FLAGS = ['forecast', 'scorecard', 'baseline', 'settlement', 'out-html', 'out-md'];

function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (argv[i] === '-h' || argv[i] === '--help') { process.stdout.write(usage() + '\n'); process.exit(0); }
    if (!argv[i].startsWith('--') || !FLAGS.includes(key)) {
      process.stderr.write(`未知参数: ${argv[i]}\n${usage()}\n`);
      process.exit(1);
    }
    args[key] = argv[++i];
  }
  for (const k of FLAGS) {
    if (!args[k]) { process.stderr.write(`缺少参数 --${k}\n${usage()}\n`); process.exit(1); }
  }

  const doc = parseForecast(fs.readFileSync(args.forecast, 'utf-8'));
  const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
  const { html, md } = renderReport({
    doc,
    scorecard: readJson(args.scorecard),
    baseline: readJson(args.baseline),
    settlement: readJson(args.settlement),
  });
  atomicWriteText(path.resolve(args['out-html']), html);
  atomicWriteText(path.resolve(args['out-md']), md);
  console.error(`报告已渲染: ${args['out-html']} / ${args['out-md']}`);
}

if (require.main === module) main();
module.exports = { escapeHtml, safeUrl, sparkline, priceChart, brierChart, renderReport, renderBlocks, inline };
