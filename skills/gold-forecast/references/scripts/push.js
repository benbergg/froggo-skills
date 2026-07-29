#!/usr/bin/env node
'use strict';
// 报告摘要 / 失败简报 → 飞书,带发送去重。
//
// 凭证由 openclaw 自己的配置持有,本脚本既不读也不传 —— 命令行参数对同机其他进程可见。
//
// 退出码:0=已发送或因去重跳过 1=参数错 4=openclaw 发送失败 5=运行期异常
//
// 5 必须与 1 分开:run.js 要能分清「我传错参数」和「状态文件/输入文件读不了」。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { parseForecast } = require('./forecast-parser');
const { N_BY_HORIZON } = require('./baseline');
const { atomicWriteJSON } = require('./lib/atomic-write');

// openclaw 不在非交互 shell 的 PATH 中(实测 ssh vm 'which openclaw' 失败),必须用绝对路径
const OPENCLAW = process.env.OPENCLAW_BIN || `${process.env.HOME}/.npm-global/bin/openclaw`;
const SEND_TIMEOUT_MS = 60_000;
const KEEP_HASHES = 200;
const HORIZONS = ['short', 'medium', 'long'];
const HORIZON_LABEL = { short: '短期', medium: '中期', long: '长期' };
const NO_DATE = '未标注日期';

// 免责声明全文含「仓位、杠杆、买卖点位或止损价」字样,不能整段搬进推送摘要 ——
// 摘要的红线是「一个交易指令词都不出现」,连否定式的都不留,免得日后被截图误读。
const PUSH_NOTE = '本消息由 gold-forecast 自动生成,为研究记录,不构成投资建议。';

const messageHash = (payload) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);

// cron 重试或手动重跑都会再发一次 —— predictions 有 upsert 保护,推送没有。
function sentFile(stateDir) { return path.join(stateDir, 'sent.json'); }

// 告警通道自己不能有单点(设计 3.4 的存在理由)。cron 超时 kill 或 VM OOM
// (那台机器只有 1.9G)在写入中途打断就留下截断的 sent.json,裸 JSON.parse 会让此后
// **每一条**消息都发不出去 —— 包括本该告诉人出事了的那条。故不可解析即按空账本处理,
// 但必须 WARN:静默降级会让「去重失效」这件事本身也无人知晓。
function readSent(stateDir) {
  const f = sentFile(stateDir);
  if (!fs.existsSync(f)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e) {
    process.stderr.write(`WARN: ${f} 无法解析(${e.message}),本次按空发送记录处理,去重暂时失效\n`);
    return [];
  }
  const hashes = parsed && parsed.hashes;
  // 字符串也有 .includes():不校验类型,去重会悄悄退化成子串匹配并误判成「已发送」
  if (!Array.isArray(hashes)) {
    if (hashes !== undefined) process.stderr.write(`WARN: ${f} 的 hashes 不是数组,已按空发送记录处理\n`);
    return [];
  }
  return hashes.filter((h) => typeof h === 'string');
}

function alreadySent(stateDir, hash) {
  return readSent(stateDir).includes(hash);
}

function markSent(stateDir, hash) {
  const hashes = [...new Set([...readSent(stateDir), hash])].slice(-KEEP_HASHES);
  // 与 commit.js 同用原子写:半截文件会把「去重记录」变成「推送总闸」
  atomicWriteJSON(sentFile(stateDir), { hashes }, { keepVersions: 0 });
}

// ---- 文案 ---------------------------------------------------------------

// String() 而非 toLocaleString():千分位逗号会打断「摘要里必须出现 3987」这类子串校验
const priceText = (v) => (Number.isFinite(v) ? String(v) : '—');
const pctText = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const brierText = (v) => (Number.isFinite(v) ? Number(v).toFixed(4) : '—');

// Number('') === 0 且 isFinite,空串会渲染出「退出码 」「已连续失败  天」这种空洞
function finiteOf(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

// 告警的挂钟日期。设计里「目标日不用 new Date()」约束的是进入预测记录的日期字段
// (防前视与漂移),不约束「这条告警是什么时候发的」—— 后者缺了会让跨天的重复告警
// 因正文完全相同而被去重吞掉,连挂三天只收到一条。
function todayLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// direction 由模型给出、prob_up 由二元口径推导(设计 5.1),两者不一致时以 prob_up 为准 ——
// 概率是下游结算与 Brier 的唯一输入,让文字压过它会让摘要和统计各说各话。
function dirText(h) {
  if (Number.isFinite(h && h.prob_up)) return h.prob_up > 0.5 ? '看涨' : '看跌';
  if (h && h.direction === 'up') return '看涨';
  if (h && h.direction === 'down') return '看跌';
  return '—';
}

function forecastLines(horizons) {
  return HORIZONS.map((k) => {
    const h = horizons && horizons[k];
    const head = `${HORIZON_LABEL[k]}(T+${N_BY_HORIZON[k]})`;
    if (!h) return `${head} 预测缺失`;
    return `${head} ${dirText(h)} ${pctText(h.prob_up)} 区间 ${priceText(h.low)} – ${priceText(h.high)}`;
  });
}

// 三档形态各有含义,不可混:数字齐全 / insufficient_sample(样本不够) /
// 整个键缺失(记分卡本身没算出来)。后两者合并上报会让「记分卡坏了」永远查不出来。
function scoreLines(byHorizon) {
  return HORIZONS.map((k) => {
    const st = byHorizon && byHorizon[k];
    const label = HORIZON_LABEL[k];
    if (!st) return `${label} 记分卡无该周期数据`;
    if (st.insufficient_sample) return `${label} 样本不足(已结算 ${Number.isFinite(st.n) ? st.n : 0} 期),不呈现胜率与 Brier`;
    const f = st.final || {};
    const b = st.baseline || {};
    const nv = st.naive || {};
    return `${label} ${Number.isFinite(st.n) ? st.n : 0} 期 · 方向胜率 最终 ${pctText(f.dir_rate)}`
      + ` / 基线 ${pctText(b.dir_rate)} / 朴素 ${pctText(nv.dir_rate)}`
      + ` · Brier ${brierText(f.brier)} / ${brierText(b.brier)} / ${brierText(nv.brier)}`;
  });
}

// 取最近结算的那一期 short:按 settled_date 取尾而非按数组下标 ——
// 逾期 approx 结算会让写入顺序与结算时序不一致。
function pickLastSettled(db) {
  const rows = ((db && db.predictions) || [])
    .map((p) => ({ p, h: (p && p.horizons && p.horizons.short) || null }))
    .filter((x) => x.h && x.h.settled && x.h.score);
  if (!rows.length) return null;
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort((x, y) => cmp(x.h.settled_date || '', y.h.settled_date || '') || cmp(x.p.id || '', y.p.id || ''));
  const { p, h } = rows[rows.length - 1];
  return {
    id: p.id,
    degraded: Boolean(p.degraded),
    prob_up: h.final && h.final.prob_up,
    actual: h.actual,
    dir_correct: h.score.dir_correct,
    settled_date: h.settled_date,
    settled_kind: h.settled_kind,
  };
}

// 单条可问责的复盘,与聚合胜率是两件事,故独立成段、绝不挂在 insufficient_sample 分支里:
// MIN_SAMPLE=20 意味着 long 要两个月才凑满,而头几周恰是用户盯得最紧的时候 ——
// 合进三方对照等于那段时间「一条反思都收不到」。
// 「昨天说涨 58%,实际收 4048.6,错了」是主线;「25 期胜率 57.1%」是体检报告,替代不了。
function lastSettledLine(ls) {
  if (!ls) return '暂无已结算记录(首期,或上期尚未到结算日)';
  const hit = typeof ls.dir_correct === 'boolean' ? (ls.dir_correct ? '✓ 命中' : '✗ 未中') : '—';
  const kind = ls.settled_kind === 'approx' ? '(延迟结算)' : '';
  return `上期(${ls.id}) 预测${dirText(ls)} ${pctText(ls.prob_up)}`
    + ` / 实际 ${priceText(ls.actual)}${kind} / 方向 ${hit}`
    + (ls.degraded ? ' · 该期为降级预测,不计入统计' : '');
}

function buildSummary({ doc, scorecard = {}, url = '', date = '', lastSettled = null }) {
  const horizons = (doc && doc.json && doc.json.horizons) || {};
  const lines = [
    `📈 黄金交易预测 · ${date || NO_DATE}`,
    '',
    '【三期预测】',
    ...forecastLines(horizons),
    '',
    '【上期结算】',
    lastSettledLine(lastSettled),
    '',
    '【三方对照 · 截至上期结算】',
    ...scoreLines(scorecard.by_horizon),
  ];
  if (url) lines.push('', `归档报告 ${url}`);
  lines.push('', PUSH_NOTE);
  return lines.join('\n');
}

// 结算(Step 2)先于预测链路且不依赖其数据源,绝大多数失败场景下结算都已完成。
// 简报必须写明这一点,否则用户会误以为统计断档而去手工补数。
function buildFailureBrief({ step, code, settled, consecutive, date = '' }) {
  const codeNum = finiteOf(code);
  const consNum = finiteOf(consecutive);
  const lines = [
    `⚠️ 黄金交易预测流水线失败 · ${date || NO_DATE}`,
    '',
    `失败步骤 ${step || '未知'} · 退出码 ${codeNum === null ? '未知' : codeNum}`,
    settled
      ? '当日结算已完成,历史统计与记分卡不受本次失败影响。'
      : '当日结算未完成,本期统计将出现缺口,需在下次运行时补结。',
  ];
  // 未提供时不编造:天数是「偶发还是坏了」的唯一线索,填 0 或 1 会误导判断
  if (consNum !== null) {
    lines.push(`已连续失败 ${consNum} 天。`);
  }
  lines.push('', '请检查 VM 上 gold-forecast 的运行日志与权威状态目录。', PUSH_NOTE);
  return lines.join('\n');
}

// ---- 发送 ---------------------------------------------------------------

// --account 必须显式传:本机装了多个飞书账号,open_id 按应用隔离,
// 漏传会被拒 feishu_code=99992361 open_id cross app。而 --dry-run 不校验收件人,
// 换 target/account 后必须真发一条验证,只看 dry-run 会以为配对了。
function sendFeishu(text, { bin = OPENCLAW, target, account, dryRun }) {
  const argv = ['message', 'send', '--channel', 'feishu', '--account', account, '-t', target, '-m', text];
  if (dryRun) argv.push('--dry-run');
  const r = spawnSync(bin, argv, { encoding: 'utf-8', timeout: SEND_TIMEOUT_MS });
  return {
    ok: r.status === 0,
    code: r.status,
    stderr: (r.stderr || '').trim(),
    error: r.error ? String(r.error.message) : null,
  };
}

const isTruthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

// ---- CLI ---------------------------------------------------------------

const FLAGS = ['mode', 'forecast', 'scorecard', 'predictions', 'url', 'date', 'state-dir', 'step',
  'code', 'settled', 'consecutive', 'target', 'account'];

function usage() {
  return [
    'Usage: push.js --mode report  --forecast <md> --scorecard <json> --predictions <json>',
    '                              --url <url> [--date YYYY-MM-DD]',
    '       push.js --mode failure --step <name> --code <n> --settled <0|1> [--consecutive <n>] [--date …]',
    '',
    '公共: [--state-dir <dir>] [--target <open_id>] [--account <name>]',
    '',
    'SEND_NOTIFY=1 才真发,默认 --dry-run;dry-run 不写入已发送记录。',
    '收件人取 --target / GOLD_FEISHU_TARGET,账号取 --account / GOLD_FEISHU_ACCOUNT。',
    'failure 模式缺 --date 时取挂钟日期,不留「未标注日期」——否则跨天告警会被去重吞掉。',
    '',
    'Exit: 0=已发送或因去重跳过 1=参数错 4=发送失败 5=运行期异常',
  ].join('\n');
}

function die(msg) {
  process.stderr.write(`${msg}\n${usage()}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-h' || argv[i] === '--help') { process.stdout.write(usage() + '\n'); process.exit(0); }
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !FLAGS.includes(key)) die(`未知参数: ${argv[i]}`);
    args[key] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode;
  if (mode !== 'report' && mode !== 'failure') die('--mode 必须是 report 或 failure');

  const home = process.env.HOME || '';
  const stateDir = path.resolve(args['state-dir'] || path.join(home, '.local', 'state', 'gold-forecast'));
  const target = args.target || process.env.GOLD_FEISHU_TARGET;
  const account = args.account || process.env.GOLD_FEISHU_ACCOUNT || 'helios';
  if (!target) die('缺少收件人:--target 或 环境变量 GOLD_FEISHU_TARGET');

  let text;
  let stamp;
  if (mode === 'report') {
    if (!args.forecast || !args.scorecard) die('--mode report 需要 --forecast 与 --scorecard');
    // --predictions 是「上期结算」单条复盘的唯一数据源,设为必填而非可选:
    // 可选的话漏传一次那一段就整体消失,而它恰恰是头几周唯一的向后看内容
    if (!args.predictions) die('--mode report 需要 --predictions(上期结算复盘的唯一数据源)');
    stamp = args.date || '';
    text = buildSummary({
      doc: parseForecast(fs.readFileSync(args.forecast, 'utf-8')),
      scorecard: JSON.parse(fs.readFileSync(args.scorecard, 'utf-8')),
      lastSettled: pickLastSettled(JSON.parse(fs.readFileSync(args.predictions, 'utf-8'))),
      url: args.url || '',
      date: stamp,
    });
  } else {
    if (!args.step) die('--mode failure 需要 --step');
    // 缺 --date 就落挂钟日期:正文里必须有随日期变化的成分,否则「连挂三天」
    // 三条告警正文完全相同,后两条被自己的去重吞掉
    stamp = args.date || todayLocal();
    text = buildFailureBrief({
      step: args.step,
      code: args.code,
      settled: isTruthy(args.settled),
      consecutive: args.consecutive,
      date: stamp,
    });
  }

  // 哈希覆盖正文全文:改了措辞就该当新消息发,否则修完文案的重跑会被自己顶掉
  const hash = messageHash({ mode, date: stamp, text });
  if (alreadySent(stateDir, hash)) {
    process.stderr.write(`该内容(${hash})已发送过,跳过\n`);
    return;
  }

  const dryRun = !isTruthy(process.env.SEND_NOTIFY);
  const r = sendFeishu(text, { target, account, dryRun });
  if (!r.ok) {
    process.stderr.write(`FATAL: openclaw message send exit ${r.code}${r.error ? ` / ${r.error}` : ''}: ${r.stderr}\n`
      + '飞书通知未发出\n');
    process.exit(4);
  }
  // dry-run 不记账:演练一次就把当天的真发永久顶掉,而这条路径正是失败告警在用的
  if (!dryRun) markSent(stateDir, hash);
  process.stderr.write(`${dryRun ? '演练' : '已发送'} ${mode} 消息(${hash})\n`);
}

// 运行期异常单独退 5:退 1 会和「参数错」撞在一起,run.js 无从区分
// 「我传错参数」和「状态文件/输入文件读不了」。
if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`FATAL: 运行期异常: ${(e && e.message) || e}\n`);
    process.exit(5);
  }
}

module.exports = { messageHash, readSent, alreadySent, markSent, buildSummary, buildFailureBrief,
  pickLastSettled, sendFeishu, sentFile, todayLocal };
