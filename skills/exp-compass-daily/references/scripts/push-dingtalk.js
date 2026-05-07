#!/usr/bin/env node
// exp-compass-daily / push-dingtalk.js
// Pushes the daily MD (already written to Knowledge-Library) to a DingTalk
// OA Report (企业内部应用 /topapi/report/create), splitting it into the four
// H1-anchored fields the report template expects.
//
// Usage:
//   node push-dingtalk.js [--date 2026-05-07] [--md /custom/path.md]
//
// Required env:
//   DINGTALK_APPKEY        企业内部应用 AppKey
//   DINGTALK_APPSECRET     AppSecret
//   DINGTALK_USERID        创建日志的 userid (会显示为提交人)
//   DINGTALK_TEMPLATE_ID   日志模板 report_code
//
// Optional env:
//   DINGTALK_TO_CHAT       "true"|"false" (default false)
//   DINGTALK_TO_USERIDS    JSON array of additional receiver userids
//   DINGTALK_TO_CIDS       JSON array of additional receiver chat ids
//   DRY_RUN                "1" -> print payload, do not call API
//
// Output:
//   stdout: DINGTALK_REPORT_OK report_id={rid}
//   exit 2  gettoken failed
//   exit 3  create_report failed
//   exit 1  other (bad MD, missing env, ...)

'use strict';

const fs = require('fs');
const path = require('path');

// ---- arg parsing --------------------------------------------------------

function parseArgs(argv) {
  const out = { date: null, md: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--date') { out.date = v; i++; }
    else if (k === '--md') { out.md = v; i++; }
  }
  if (!out.date) {
    const d = new Date();
    out.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (!out.md) {
    out.md = path.join(process.env.HOME, 'Knowledge-Library', '05-Reports', 'daily', `${out.date}.md`);
  }
  return out;
}

// ---- env check ----------------------------------------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: env ${name} is required`);
    process.exit(1);
  }
  return v;
}

function sanitizeMessage(s) {
  return String(s)
    .replace(/access_token=\S+/gi, 'access_token=***')
    .replace(/appsecret=\S+/gi, 'appsecret=***')
    .replace(/appkey=\S+/gi, 'appkey=***');
}

// ---- MD slicing ---------------------------------------------------------

const ANCHORS = [
  { h1: '# 一、研发概览', key: '概览' },
  { h1: '# 二、需求推进', key: '需求推进' },
  { h1: '# 三、今日产出', key: '今日产出' },
  { h1: '# 四、今日总结', key: '今日总结' },
];

function sliceMarkdown(md) {
  // Find all 4 anchor positions; return { 概览: '...', 需求推进: '...', ... }
  const lines = md.split('\n');
  const positions = ANCHORS.map((a) => ({
    ...a,
    line: lines.findIndex((l) => l === a.h1),
  }));

  const missing = positions.filter((p) => p.line === -1);
  if (missing.length > 0) {
    const list = missing.map((m) => m.h1).join(', ');
    throw new Error(`MD missing required H1 anchors: ${list}`);
  }
  // Anchors must be in document order (concept §5.2 #6)
  for (let i = 1; i < positions.length; i++) {
    if (positions[i].line < positions[i - 1].line) {
      throw new Error(`MD H1 anchors out of order at "${positions[i].h1}"`);
    }
  }

  const sections = {};
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].line + 1;
    const end = i + 1 < positions.length ? positions[i + 1].line : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    sections[positions[i].key] = body;
  }
  return sections;
}

// ---- DingTalk API -------------------------------------------------------

async function getAccessToken(appkey, appsecret) {
  const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appkey)}&appsecret=${encodeURIComponent(appsecret)}`;
  let resp;
  try {
    resp = await fetch(url, { method: 'GET' });
  } catch (e) {
    console.error(`FATAL: gettoken network error: ${sanitizeMessage(e.message)}`);
    process.exit(2);
  }
  let body;
  try {
    body = await resp.json();
  } catch (e) {
    console.error(`FATAL: gettoken response is not JSON (status=${resp.status})`);
    process.exit(2);
  }
  if (body.errcode !== 0 || !body.access_token) {
    console.error(`FATAL: gettoken failed: errcode=${body.errcode} errmsg=${body.errmsg}`);
    process.exit(2);
  }
  return body.access_token;
}

async function createReport(accessToken, payload) {
  const url = `https://oapi.dingtalk.com/topapi/report/create?access_token=${encodeURIComponent(accessToken)}`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error(`FATAL: create_report network error: ${sanitizeMessage(e.message)}`);
    process.exit(3);
  }
  let body;
  try {
    body = await resp.json();
  } catch (e) {
    console.error(`FATAL: create_report response is not JSON (status=${resp.status})`);
    process.exit(3);
  }
  if (body.errcode !== 0) {
    console.error(`DINGTALK_REPORT_FAIL: errcode=${body.errcode} errmsg=${body.errmsg}`);
    if (body.errmsg && /template/i.test(body.errmsg)) {
      console.error('HINT: errmsg references template — verify DINGTALK_TEMPLATE_ID and that the 4 contents.key match the template field names exactly.');
    }
    process.exit(3);
  }
  // result may be an object {report_id} or scalar; normalize
  if (body.result && typeof body.result === 'object') {
    return body.result.report_id || 'ok';
  }
  return body.result != null ? String(body.result) : 'ok';
}

// ---- main ---------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const appkey = requireEnv('DINGTALK_APPKEY');
  const appsecret = requireEnv('DINGTALK_APPSECRET');
  const userid = requireEnv('DINGTALK_USERID');
  const templateId = requireEnv('DINGTALK_TEMPLATE_ID');

  if (!fs.existsSync(args.md)) {
    console.error(`FATAL: MD file not found: ${args.md}`);
    process.exit(1);
  }
  const md = fs.readFileSync(args.md, 'utf-8');

  let sections;
  try {
    sections = sliceMarkdown(md);
  } catch (e) {
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }

  const contents = ANCHORS.map((a, i) => ({
    sort: String(i),
    key: a.key,
    type: '1',
    content_type: 'markdown',
    content: sections[a.key],
  }));

  // Sanity: all 4 contents must have non-empty content
  const empty = contents.filter((c) => !c.content);
  if (empty.length > 0) {
    console.error(`FATAL: empty section(s): ${empty.map((c) => c.key).join(', ')}`);
    process.exit(1);
  }

  // Receivers (default: don't send to chat, no extra recipients)
  const toChat = process.env.DINGTALK_TO_CHAT === 'true';
  let toUserIds = [];
  let toCids = [];
  if (process.env.DINGTALK_TO_USERIDS) {
    try { toUserIds = JSON.parse(process.env.DINGTALK_TO_USERIDS); }
    catch (_) { console.error('WARN: DINGTALK_TO_USERIDS is not valid JSON, ignoring'); }
  }
  if (process.env.DINGTALK_TO_CIDS) {
    try { toCids = JSON.parse(process.env.DINGTALK_TO_CIDS); }
    catch (_) { console.error('WARN: DINGTALK_TO_CIDS is not valid JSON, ignoring'); }
  }

  const payload = {
    create_report_param: {
      userid,
      template_id: templateId,
      dd_from: 'openapi',
      contents,
      to_chat: toChat,
      to_userids: toUserIds,
      to_cids: toCids,
    },
  };

  if (process.env.DRY_RUN === '1') {
    console.log('=== DRY_RUN payload ===');
    console.log(JSON.stringify(payload, null, 2));
    process.exit(0);
  }

  const accessToken = await getAccessToken(appkey, appsecret);
  const reportId = await createReport(accessToken, payload);

  console.log(`DINGTALK_REPORT_OK report_id=${reportId}`);
}

main().catch((e) => {
  console.error(`FATAL: ${sanitizeMessage(e.message)}`);
  process.exit(1);
});
