#!/usr/bin/env node
// exp-compass-daily / build-draft.js
// Reads the daily markdown, slices it into 4 sections by H1 anchors, and
// outputs a contents JSON suitable for `dingtalk-log save-content --contents`.
//
// Usage:
//   node build-draft.js --md /path/to/{DATE}.md --date 2026-05-11 [--out /tmp/x.json]
//
// Optional env:
//   DINGTALK_EXP_COMPASS_FIELD_NAMES_JSON  JSON array of 4 strings overriding ANCHORS.key
//
// Output:
//   stdout (or --out file): {"contents":[{key,sort,type,content_type,content},...]}
//   exit 0  ok
//   exit 1  bad args / IO error
//   exit 4  H1 anchor missing or out of order

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ANCHORS = [
  { h1: '# 一、研发概览', key: '一、研发概览' },
  { h1: '# 二、需求推进', key: '二、 需求推进' },
  { h1: '# 三、今日产出', key: '三、今日产出' },
  { h1: '# 四、今日总结', key: '四、今日总结' },
];

function parseArgs(argv) {
  const out = { md: null, date: null, outFile: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--md') { out.md = v; i++; }
    else if (k === '--date') { out.date = v; i++; }
    else if (k === '--out') { out.outFile = v; i++; }
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

function main() {
  const args = parseArgs(process.argv);
  if (!args.md) { console.error('FATAL: --md is required'); process.exit(1); }
  if (!args.date) { console.error('FATAL: --date is required'); process.exit(1); }
  if (!fs.existsSync(args.md)) { console.error(`FATAL: MD file not found: ${args.md}`); process.exit(1); }

  const md = fs.readFileSync(args.md, 'utf-8');
  const anchors = resolveAnchors();
  const sections = sliceMarkdown(md, anchors);

  const contents = anchors.map((a, i) => ({
    sort: String(i),
    key: a.key,
    type: '1',
    content_type: 'markdown',
    content: sections[a.key],
  }));

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
