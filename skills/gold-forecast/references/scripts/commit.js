#!/usr/bin/env node
'use strict';
// 通过自检的预测产物 → 权威库入库 + 知识库归档 + 备份副本。
//
// 三份副本职责不同(设计 3.3):权威库 ~/.local/state 是唯一读取源,
// ~/backup 是唯一恢复源(在任何同步范围之外),知识库 05-Reports/gold 只供查阅。
//
// 退出码:0=成功 1=参数错 3=入库与归档已成功但备份失败 5=运行期异常
//
// 5 必须与 1 分开:run.js 要能分清「我传错参数」和「权威库损坏/文件读不了」。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { atomicWriteText, atomicWriteJSON } = require('./lib/atomic-write');
const { DISCLAIMER_TEXT } = require('./lib/disclaimer');
const { escapeHtml } = require('./render');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BACKUP_TIMEOUT_MS = 120_000;

// ---- 入库 ---------------------------------------------------------------

// 整条覆盖而非字段合并:只有通过自检的产物才走到 Step 6,覆盖的一定是更完整的版本;
// 合并会让上一版的残留字段永生,而记分卡分不出「本期没算」和「上期留下的」。
// 落库前 structuredClone:上游装配的 naive_p / c9_triggered 等字段一个都不丢,
// 同时切断与调用方 record 的别名 —— 拷贝与不丢字段是两件事,别混。
function upsertPrediction(db, record) {
  if (!record || typeof record.id !== 'string' || !ISO_DATE_RE.test(record.id)) {
    throw new Error(`commit: record.id 必须是 YYYY-MM-DD,实得 ${JSON.stringify(record && record.id)}`);
  }
  // 非数组绝不静默重置成 []:紧接着的 atomicWriteJSON 会用这一条记录覆盖掉整个权威历史库,
  // 静默 + 不可逆 + 打在唯一事实源上。同仓 settle.js / scorecard.js 遇此直接崩,那才是对的。
  if (db.predictions !== undefined && !Array.isArray(db.predictions)) {
    throw new Error('commit: db.predictions 必须是数组,实得 '
      + `${JSON.stringify(db.predictions).slice(0, 80)} —— 拒绝写入,以免覆盖权威历史库`);
  }
  const predictions = Array.isArray(db.predictions) ? db.predictions : [];
  const stored = structuredClone(record);
  const at = predictions.findIndex((p) => p && p.id === record.id);
  let action;
  if (at >= 0) { predictions[at] = stored; action = 'updated'; }
  else { predictions.push(stored); action = 'inserted'; }
  // ISO 日期字符串的字典序即时间序,直接比较即可
  predictions.sort((a, b) => ((a && a.id) < (b && b.id) ? -1 : (a && a.id) > (b && b.id) ? 1 : 0));
  db.predictions = predictions;
  return { db, action };
}

// ---- 归档索引 -----------------------------------------------------------

function yearOf(id) {
  const y = Number(String(id || '').slice(0, 4));
  return Number.isInteger(y) ? y : NaN;
}

// 年份页文件名固定 index-YYYY.html,index.html 只是最新年份的同内容副本:
// 若让 index.html 承担「当年」语义,跨年那天所有指向它的旧链接会集体改指向。
function indexFileName(year) { return `index-${year}.html`; }
function reportFileName(id, ext) { return `${id}.${ext}`; }

// String() 而非 toLocaleString():千分位逗号会打断下游的连续子串匹配
const numText = (v) => (Number.isFinite(v) ? String(v) : '—');
const pctText = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const brierText = (v) => (Number.isFinite(v) ? Number(v).toFixed(4) : '—');
// 二元口径(设计 5.1),与 settle.js 的 prob_up > 0.5 同源,不设震荡档
const dirText = (v) => (Number.isFinite(v) ? (v > 0.5 ? '看涨' : '看跌') : '—');

const INDEX_HEAD = ['日期', '基准价', '短期方向', '短期概率', '短期区间',
  '实际结算价', '方向', 'Brier 最终/基线/朴素', '模型'];

function indexRow(e) {
  const h = (e.horizons && e.horizons.short) || {};
  const f = h.final || {};
  const s = h.score || {};
  const tag = e.degraded ? '<span class="tag">降级</span>' : '';
  const hit = typeof s.dir_correct === 'boolean' ? (s.dir_correct ? '✓' : '✗') : '—';
  return [
    `<a href="${escapeHtml(reportFileName(e.id, 'html'))}">${escapeHtml(String(e.id))}</a>${tag}`,
    numText(e.base_price),
    dirText(f.prob_up),
    pctText(f.prob_up),
    Number.isFinite(f.low) && Number.isFinite(f.high) ? `${numText(f.low)} – ${numText(f.high)}` : '—',
    numText(h.actual),
    hit,
    `${brierText(s.brier)} / ${brierText(s.baseline_brier)} / ${brierText(s.naive_brier)}`,
    escapeHtml(String(e.model_id || '—')),
  ];
}

const INDEX_CSS = [
  ':root{--bg:#F4F1EC;--fg:#23201c;--mut:#6b645b;--line:#d8d1c6;--acc:#a8641f}',
  '@media (prefers-color-scheme:dark){:root{--bg:#191715;--fg:#e8e3da;--mut:#9a9287;--line:#3a352f;--acc:#e0a35c}}',
  'body{background:var(--bg);color:var(--fg);font-family:-apple-system,"Helvetica Neue",sans-serif;',
  'margin:0;padding:32px 20px;line-height:1.6}',
  '.wrap{max-width:1040px;margin:0 auto}',
  'h1{font-family:Georgia,"Songti SC",serif;font-size:26px;margin:0 0 4px}',
  '.sub{color:var(--mut);font-size:13px;margin:0 0 20px}',
  '.nav{font-size:14px;margin:0 0 18px}.nav a{color:var(--acc)}.nav .cur{font-weight:700}',
  '.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}',
  'th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;white-space:nowrap}',
  'th{color:var(--mut);font-weight:600}',
  '.tag{margin-left:6px;font-size:11px;color:var(--acc);border:1px solid var(--acc);border-radius:3px;padding:0 3px}',
  'footer{margin-top:26px;color:var(--mut);font-size:12px}',
].join('');

// 只渲染 year 当年条目:不分页会随年份累积无限膨胀(设计 L-7)。
// year 必须显式传 —— 缺省成「全部年份」会让分页形同虚设,而且不报错所以永不被发现。
function buildIndex(entries, { year } = {}) {
  if (!Number.isInteger(Number(year))) {
    throw new Error(`commit.buildIndex: 必须显式传 { year: <整数年份> },实得 ${JSON.stringify(year)}`);
  }
  const yr = Number(year);
  const all = Array.isArray(entries) ? entries.filter((e) => e && e.id) : [];
  const years = [...new Set(all.map((e) => yearOf(e.id)).filter(Number.isInteger))].sort((a, b) => b - a);
  const rows = all.filter((e) => yearOf(e.id) === yr).sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const settled = rows.filter((e) => e.horizons && e.horizons.short && e.horizons.short.settled).length;

  const nav = years.map((y) => (y === yr
    ? `<span class="cur">${y}</span>`
    : `<a href="${escapeHtml(indexFileName(y))}">${y}</a>`)).join(' · ');
  const th = INDEX_HEAD.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const body = rows.map((e) => `<tr>${indexRow(e).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n');

  return ['<!DOCTYPE html>', '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(`黄金交易预测归档 · ${yr}`)}</title>`,
    `<style>${INDEX_CSS}</style></head><body><div class="wrap">`,
    `<h1>${escapeHtml(`黄金交易预测归档 · ${yr}`)}</h1>`,
    `<p class="sub">${escapeHtml(`本年 ${rows.length} 期,短周期已结算 ${settled} 期 · 自动生成,勿手工编辑`)}</p>`,
    `<p class="nav">${nav || escapeHtml(String(yr))}</p>`,
    `<div class="tw"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`,
    `<footer>${escapeHtml(DISCLAIMER_TEXT)}</footer>`,
    '</div></body></html>', ''].join('\n');
}

// 归档件可由 predictions.json 完整重算,keepVersions:0 —— 否则知识库里会长出
// 一个 versions/ 目录,跟着 vault 同步到处跑。
const writeArchive = (p, text) => atomicWriteText(p, text, { keepVersions: 0 });

function writeIndexes({ archiveDir, entries }) {
  const years = [...new Set((entries || []).filter((e) => e && e.id)
    .map((e) => yearOf(e.id)).filter(Number.isInteger))].sort((a, b) => a - b);
  const written = [];
  for (const y of years) {
    const p = path.join(archiveDir, indexFileName(y));
    writeArchive(p, buildIndex(entries, { year: y }));
    written.push(p);
  }
  if (years.length) {
    const p = path.join(archiveDir, 'index.html');
    writeArchive(p, buildIndex(entries, { year: years[years.length - 1] }));
    written.push(p);
  }
  return written;
}

// ---- 备份 ---------------------------------------------------------------

// 不带 --delete:2026-07-28 知识库同步一次提交删掉 VM 两个归档件的实证说明备份必须只增不减。
// 加了 --delete,权威目录被误删后一次 rsync 就把恢复源一并抹平。
function backupState({ stateDir, backupDir, bin = 'rsync' }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const slash = (p) => p.replace(/\/*$/, '/');
  const r = spawnSync(bin, ['-a', slash(stateDir), slash(backupDir)],
    { encoding: 'utf-8', timeout: BACKUP_TIMEOUT_MS });
  return {
    ok: r.status === 0,
    code: r.status,
    stderr: (r.stderr || '').trim(),
    error: r.error ? String(r.error.message) : null,
  };
}

// ---- CLI ---------------------------------------------------------------

const FLAGS = ['record', 'predictions', 'state-dir', 'archive-dir', 'report-html', 'report-md',
  'scorecard', 'backup-dir'];
const BOOLS = ['no-backup'];

function usage() {
  return [
    'Usage: commit.js --record <json> --archive-dir <dir>',
    '                 [--report-html <path>] [--report-md <path>] [--scorecard <json>]',
    '                 [--predictions <json>] [--state-dir <dir>] [--backup-dir <dir>] [--no-backup]',
    '',
    '--archive-dir 亦可由环境变量 GOLD_ARCHIVE_DIR 提供;无默认值,不猜知识库路径。',
    'GOLD_RSYNC_BIN 可覆盖 rsync 可执行文件路径(测试与非标准环境用)。',
    '',
    'Exit: 0=成功 1=参数错 3=入库与归档已成功但备份失败 5=运行期异常',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-h' || argv[i] === '--help') { process.stdout.write(usage() + '\n'); process.exit(0); }
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || (!FLAGS.includes(key) && !BOOLS.includes(key))) {
      die(`未知参数: ${argv[i]}`);
    }
    if (BOOLS.includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

function die(msg) {
  process.stderr.write(`${msg}\n${usage()}\n`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.record) die('缺少参数 --record');
  const archiveDir = args['archive-dir'] || process.env.GOLD_ARCHIVE_DIR;
  if (!archiveDir) die('缺少参数 --archive-dir(或环境变量 GOLD_ARCHIVE_DIR)');

  const home = process.env.HOME || '';
  const stateDir = path.resolve(args['state-dir'] || path.join(home, '.local', 'state', 'gold-forecast'));
  const dbPath = path.resolve(args.predictions || path.join(stateDir, 'predictions.json'));
  const arch = path.resolve(archiveDir);

  const record = JSON.parse(fs.readFileSync(args.record, 'utf-8'));
  const db = fs.existsSync(dbPath)
    ? JSON.parse(fs.readFileSync(dbPath, 'utf-8'))
    : { schema_version: 2, predictions: [], skipped_dates: [] };
  const { action } = upsertPrediction(db, record);
  atomicWriteJSON(dbPath, db);

  if (args['report-html']) writeArchive(path.join(arch, reportFileName(record.id, 'html')), fs.readFileSync(args['report-html'], 'utf-8'));
  if (args['report-md']) writeArchive(path.join(arch, reportFileName(record.id, 'md')), fs.readFileSync(args['report-md'], 'utf-8'));
  const indexes = writeIndexes({ archiveDir: arch, entries: db.predictions });

  // _data 仅供查阅,明确不作恢复源(设计 3.3)
  writeArchive(path.join(arch, '_data', 'predictions.json'), JSON.stringify(db, null, 2) + '\n');
  if (args.scorecard) writeArchive(path.join(arch, '_data', 'scorecard.json'), fs.readFileSync(args.scorecard, 'utf-8'));

  process.stderr.write(`入库 ${record.id} (${action}),归档 ${arch},索引 ${indexes.length} 页\n`);

  if (args['no-backup']) return;
  const b = backupState({
    stateDir,
    backupDir: path.resolve(args['backup-dir'] || path.join(home, 'backup', 'gold-forecast')),
    bin: process.env.GOLD_RSYNC_BIN || 'rsync',
  });
  if (!b.ok) {
    // 备份是唯一恢复源,失败必须刺眼:入库已成功,重跑本命令是幂等的
    process.stderr.write(`FATAL: 备份失败(exit ${b.code}${b.error ? ` / ${b.error}` : ''}): ${b.stderr}\n`
      + '入库与归档已完成,修好备份后重跑本命令即可(upsert 幂等)\n');
    process.exit(3);
  }
}

// 运行期异常单独退 5:退 1 会和「参数错」撞在一起。权威库损坏走这条路,
// 且抛在 atomicWriteJSON 之前 —— 原文件一个字节都不动。
if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`FATAL: 运行期异常: ${(e && e.message) || e}\n`);
    process.exit(5);
  }
}

module.exports = { upsertPrediction, buildIndex, writeIndexes, backupState, indexFileName, reportFileName, yearOf };
