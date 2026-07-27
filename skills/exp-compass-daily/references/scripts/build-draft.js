#!/usr/bin/env node
// exp-compass-daily / build-draft.js
// Reads the daily markdown, slices it into 4 sections by H1 anchors, and
// outputs a contents JSON suitable for `dingtalk-log save-content --contents`.
//
// Usage:
//   node build-draft.js --md /path/to/{DATE}.md --date 2026-05-11 [--out /tmp/x.json] [--json /tmp/exp-compass-{DATE}.json]
//
// Optional env:
//   DINGTALK_EXP_COMPASS_FIELD_NAMES_JSON  JSON array of 4 strings overriding ANCHORS.key
//
// Output:
//   stdout (or --out file): {"contents":[{key,sort,type,content_type,content},...]}
//   exit 0  ok
//   exit 1  bad args / IO error
//   exit 4  H1 anchor missing or out of order
//   exit 5  --json 提供时 MD↔JSON 数据一致性校验失败(概览数字/详情表 active/待修复 Bug)
//
// --json 是 V5 物理断路:传入 collect.js 的采集 JSON,硬校验弱模型撰写的 MD
// 与采集真相是否一致,不一致 exit 5 阻断广播(不发错误数据)。未传则跳过(向后兼容)。

'use strict';

const fs = require('node:fs');

// NOTE: the second key '二、 需求推进' has a deliberate space after the 顿号 to
// match the existing DingTalk template field_name (legacy). Do NOT normalize.
const DEFAULT_ANCHORS = [
  { h1: '# 一、研发概览', key: '一、研发概览' },
  { h1: '# 二、需求推进', key: '二、 需求推进' },
  { h1: '# 三、今日产出', key: '三、今日产出' },
  { h1: '# 四、今日总结', key: '四、今日总结' },
];

function parseArgs(argv) {
  const out = { md: null, date: null, outFile: null, json: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--md') { out.md = v; i++; }
    else if (k === '--date') { out.date = v; i++; }
    else if (k === '--out') { out.outFile = v; i++; }
    else if (k === '--json') { out.json = v; i++; }
  }
  return out;
}

function resolveAnchors() {
  const override = process.env.DINGTALK_EXP_COMPASS_FIELD_NAMES_JSON;
  if (!override) return DEFAULT_ANCHORS;
  let arr;
  try { arr = JSON.parse(override); }
  catch (e) {
    console.error(`FATAL: DINGTALK_EXP_COMPASS_FIELD_NAMES_JSON not valid JSON: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(arr) || arr.length !== 4) {
    console.error('FATAL: DINGTALK_EXP_COMPASS_FIELD_NAMES_JSON must be a JSON array of length 4');
    process.exit(1);
  }
  return DEFAULT_ANCHORS.map((a, i) => ({ h1: a.h1, key: arr[i] }));
}

function sliceMarkdown(md, anchors) {
  const lines = md.split('\n');
  const positions = anchors.map((a) => ({
    ...a,
    line: lines.findIndex((l) => l === a.h1),
  }));
  const missing = positions.filter((p) => p.line === -1);
  if (missing.length > 0) {
    const list = missing.map((m) => m.h1).join(', ');
    console.error(`FATAL: MD missing required H1 anchors: ${list}`);
    process.exit(4);
  }
  for (let i = 1; i < positions.length; i++) {
    if (positions[i].line < positions[i - 1].line) {
      console.error(`FATAL: MD H1 anchors out of order at "${positions[i].h1}"`);
      process.exit(4);
    }
  }
  const sections = {};
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].line + 1;
    const end = i + 1 < positions.length ? positions[i + 1].line : lines.length;
    sections[positions[i].key] = lines.slice(start, end).join('\n').trim();
  }
  return sections;
}

function injectDateQuote(content, date) {
  // NOTE: avoid leading `>` (markdown blockquote) — DingTalk renderer
  // HTML-entity-encodes it and the UI decoder truncates `&gt;` to `&g`,
  // surfacing as a visible glitch. Use bold instead.
  return `**📅 汇报日期 ${date}**\n\n${content}`;
}

const ROW_EMOJI = { '需求': '📋', '任务': '✅', 'BUG': '🐞' };

// Normalize first-column variants the AI tends to produce ('需求 Story',
// '任务 Task', 'Bug', 'bug') back to the canonical key used by ROW_EMOJI.
function normalizeRowType(raw) {
  if (/^b/i.test(raw)) return 'BUG';
  return raw;
}

// Returns { ok: true, text } when transformed; { ok: false } when malformed
// (caller should fall back to original markdown).
function transformOverviewTable(content) {
  const lines = content.split('\n');
  const rows = [];
  const extras = [];
  for (const line of lines) {
    // First column accepts a trailing English label (e.g. '需求 Story',
    // '任务 Task') and Bug in any case. Any non-pipe trailer between the
    // type word and the closing pipe is allowed. No \b after the type:
    // JS regex word-boundary only fires on [A-Za-z0-9_], so it would never
    // trigger after the CJK characters '需求' or '任务'.
    // V4: 第 2 列(进行中)允许非纯数字 — 需求行渲染 `6 (另滞留 13)`。
    // 后 3 列仍必须纯数字,保证残缺表格照旧走 fallback。
    const m = line.match(/^\|\s*(需求|任务|[Bb][Uu][Gg])[^|]*\|\s*([^|]*?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$/);
    if (m) {
      const [, rawType, inProgress, todayNew, todayDone, todo] = m;
      if (!inProgress) return { ok: false };
      rows.push({ type: normalizeRowType(rawType), inProgress, todayNew, todayDone, todo });
    } else if (line.trim() && !line.trimStart().startsWith('|')) {
      // V4: 表格外的说明行(如 `ℹ️ BUG 行口径:…` 脚注)在转换后保留,
      // 排在 emoji 行之后。表头/分隔行以 | 开头,自然丢弃。
      extras.push(line.trim());
    }
  }
  if (rows.length !== 3) return { ok: false };
  const types = rows.map((r) => r.type).sort().join(',');
  if (types !== 'BUG,任务,需求') return { ok: false };
  // NOTE: no leading `- ` list bullet — DingTalk renderer drops it. Use emoji
  // as the visual bullet directly.
  const listLines = rows.map((r) =>
    `${ROW_EMOJI[r.type]} **${r.type}**:进行中 ${r.inProgress} / 今日新增 ${r.todayNew} / 今日完成 ${r.todayDone} / 待处理 ${r.todo}`
  );
  const text = extras.length
    ? `${listLines.join('\n')}\n\n${extras.join('\n')}`
    : listLines.join('\n');
  return { ok: true, text };
}

// ---- V5 数据一致性硬校验(--json) ------------------------------------------

// 从概览段解析 3 行的原始数字。返回 { 需求, 任务, BUG } 每项含
// { inProgressRaw, todayNew, todayDone, todo };无法解析的行不入 map。
function parseOverviewRows(section) {
  const rows = {};
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*(需求|任务|[Bb][Uu][Gg])[^|]*\|\s*([^|]*?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*$/);
    if (m) {
      const [, rawType, inProgressRaw, todayNew, todayDone, todo] = m;
      rows[normalizeRowType(rawType)] = {
        inProgressRaw,
        todayNew: Number(todayNew),
        todayDone: Number(todayDone),
        todo: Number(todo),
      };
    }
  }
  return rows;
}

// 校验 MD 与采集 JSON 的一致性。返回差异描述数组(空=通过)。
function validateAgainstJson(sections, anchors, json) {
  const diffs = [];
  const s = (json && json.summary) || {};
  const overviewKey = anchors[0].key;
  const detailKey = anchors[1].key;
  const overview = sections[overviewKey] || '';
  const detail = sections[detailKey] || '';

  // 1) 概览 12 数字。需求"进行中"=active(不是 in_progress),任务/BUG 行=in_progress。
  const rows = parseOverviewRows(overview);
  const eq = (label, got, want) => {
    if (Number(got) !== Number(want)) diffs.push(`概览 ${label}: MD=${got} != JSON=${want}`);
  };
  if (rows['需求'] && s.story) {
    const mStory = rows['需求'].inProgressRaw.match(/^(\d+)(?:\s*\(另滞留\s*(\d+)\))?/);
    const active = mStory ? Number(mStory[1]) : NaN;
    const stale = mStory && mStory[2] != null ? Number(mStory[2]) : 0;
    eq('需求·进行中(应=active)', active, s.story.active);
    if ((s.story.stale || 0) !== stale) diffs.push(`概览 需求·另滞留: MD=${stale} != JSON=${s.story.stale}`);
    eq('需求·今日新增', rows['需求'].todayNew, s.story.today_new);
    eq('需求·今日完成', rows['需求'].todayDone, s.story.today_done);
    eq('需求·待处理', rows['需求'].todo, s.story.todo);
  } else {
    diffs.push('概览: 需求行无法解析或 JSON.summary.story 缺失');
  }
  for (const [zh, key] of [['任务', 'task'], ['BUG', 'bug']]) {
    if (rows[zh] && s[key]) {
      eq(`${zh}·进行中`, Number(rows[zh].inProgressRaw), s[key].in_progress);
      eq(`${zh}·今日新增`, rows[zh].todayNew, s[key].today_new);
      eq(`${zh}·今日完成`, rows[zh].todayDone, s[key].today_done);
      eq(`${zh}·待处理`, rows[zh].todo, s[key].todo);
    } else {
      diffs.push(`概览: ${zh}行无法解析或 JSON.summary.${key} 缺失`);
    }
  }

  // 2) 二段详情表 ### 标题的 story id 全集 == JSON is_active 全集
  const detailIds = new Set();
  for (const line of detail.split('\n')) {
    const m = line.match(/^###[^\n]*?S(\d+)/);
    if (m) detailIds.add(Number(m[1]));
  }
  const activeIds = new Set((json.stories || []).filter((x) => x.is_active).map((x) => Number(x.id)));
  const missing = [...activeIds].filter((id) => !detailIds.has(id));
  const extra = [...detailIds].filter((id) => !activeIds.has(id));
  if (missing.length) diffs.push(`详情表漏 active 需求(应列未列): ${missing.map((i) => 'S' + i).join(',')}`);
  if (extra.length) diffs.push(`详情表多列非 active 需求: ${extra.map((i) => 'S' + i).join(',')}`);

  // 3) "待修复 Bug" 行的 B id 必须 status=active
  const bugStatus = new Map((json.bugs || []).map((b) => [Number(b.id), b.status]));
  for (const line of detail.split('\n')) {
    if (!line.includes('待修复 Bug')) continue;
    const ids = [...line.matchAll(/B(\d+)/g)].map((m) => Number(m[1]));
    for (const id of ids) {
      const st = bugStatus.get(id);
      if (st !== 'active') diffs.push(`待修复 Bug 段 B${id} 状态=${st || '未采集'},应为 active`);
    }
  }

  return diffs;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.md) { console.error('FATAL: --md is required'); process.exit(1); }
  if (!args.date) { console.error('FATAL: --date is required'); process.exit(1); }
  if (!fs.existsSync(args.md)) { console.error(`FATAL: MD file not found: ${args.md}`); process.exit(1); }

  const md = fs.readFileSync(args.md, 'utf-8');
  const anchors = resolveAnchors();
  const sections = sliceMarkdown(md, anchors);

  // V5 物理断路:传了 --json 就硬校验 MD↔采集 JSON,不一致 exit 5 阻断广播。
  if (args.json) {
    if (!fs.existsSync(args.json)) {
      console.error(`FATAL: --json file not found: ${args.json}`);
      process.exit(1);
    }
    let json;
    try { json = JSON.parse(fs.readFileSync(args.json, 'utf-8')); }
    catch (e) { console.error(`FATAL: --json not valid JSON: ${e.message}`); process.exit(1); }
    const diffs = validateAgainstJson(sections, anchors, json);
    if (diffs.length) {
      console.error('FATAL: MD↔JSON 数据一致性校验失败,阻断广播:');
      for (const d of diffs) console.error(`  - ${d}`);
      process.exit(5);
    }
  }

  const contents = anchors.map((a, i) => {
    let body = sections[a.key];
    if (i === 0) {
      const transformed = transformOverviewTable(body);
      if (transformed.ok) {
        body = transformed.text;
      } else {
        console.error(`WARN: overview table parse failed, falling back to original markdown`);
      }
      body = injectDateQuote(body, args.date);
    }
    return {
      sort: String(i),
      key: a.key,
      type: '1',
      content_type: 'markdown',
      content: body,
    };
  });

  const empty = contents.filter((c) => !c.content);
  if (empty.length > 0) {
    console.error(`FATAL: empty section(s): ${empty.map((c) => c.key).join(', ')}`);
    process.exit(1);
  }

  const output = JSON.stringify({ contents });
  if (args.outFile) {
    fs.writeFileSync(args.outFile, output, 'utf-8');
  } else {
    process.stdout.write(output + '\n');
  }
}

main();
