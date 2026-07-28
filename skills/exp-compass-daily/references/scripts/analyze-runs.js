#!/usr/bin/env node
'use strict';
// 采集归因分析:读 obs 落的日志,回答两个问题
//   1. 哪里不稳定 —— 端点耗时分布、超时/重试、时段相关性、跨天基线偏离
//   2. 哪里浪费   —— 每个取数策略的独有贡献(砍掉它会丢多少数据)
//
// Usage:
//   node analyze-runs.js [--last 10] [--date 2026-07-28] [--json]
//
// 退出码恒为 0:这是分析工具,不参与主流程决策。

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { last: 10, date: null, json: false, dir: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--last') { out.last = parseInt(argv[++i], 10) || 10; }
    else if (k === '--date') { out.date = argv[++i]; }
    else if (k === '--dir') { out.dir = argv[++i]; }
    else if (k === '--json') { out.json = true; }
  }
  return out;
}

function logDir(override) {
  return override || process.env.EXP_COMPASS_LOG_DIR
    || path.join(process.env.HOME || '/tmp', '.cache', 'exp-compass-daily', 'logs');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
};
const fmtMs = (ms) => (ms == null ? '-' : (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function main() {
  const args = parseArgs(process.argv);
  const dir = logDir(args.dir);
  const runs = readJsonl(path.join(dir, 'runs.jsonl')).slice(-args.last);

  if (!runs.length) {
    console.log(`没有采集日志(${dir}/runs.jsonl 不存在或为空)。`);
    console.log('collect.js 跑过至少一次之后再来。');
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({ runs }, null, 2));
    return;
  }

  // ---- 1. 运行结果概览 --------------------------------------------------
  const ok = runs.filter((r) => r.exit_code === 0);
  const failed = runs.filter((r) => r.exit_code !== 0);
  const byExit = {};
  for (const r of runs) byExit[r.exit_code] = (byExit[r.exit_code] || 0) + 1;

  console.log(`\n采集归因分析  最近 ${runs.length} 次运行  (${runs[0].date} ~ ${runs[runs.length - 1].date})\n`);
  console.log(`结果  ok=${ok.length}  失败=${failed.length}  ${Object.entries(byExit).filter(([c]) => c !== '0').map(([c, n]) => `exit${c}×${n}`).join(' ') || ''}`);
  const durs = runs.map((r) => r.duration_ms).filter(Boolean).sort((a, b) => a - b);
  console.log(`耗时  P50 ${fmtMs(pct(durs, 50))}  P95 ${fmtMs(pct(durs, 95))}  最长 ${fmtMs(durs[durs.length - 1])}`);
  const degraded = runs.filter((r) => (r.degraded_non_voc || []).length);
  if (degraded.length) console.log(`降级  ${degraded.length} 次有非 VOC 源被跳过`);

  // ---- 2. 端点稳定性 ----------------------------------------------------
  // 跨运行聚合每个 source。ms_p50/p95 取各次运行的中位数,避免单次慢窗主导。
  const srcAgg = new Map();
  for (const r of runs) {
    for (const [src, s] of Object.entries(r.by_source || {})) {
      const a = srcAgg.get(src) || { calls: 0, p50s: [], p95s: [], maxs: [], failed: 0, retries: 0, failures: {}, returned: 0, contributed: 0, unique: 0, runs: 0, role: 'data' };
      a.runs++;
      if (s.role) a.role = s.role;
      a.calls += s.calls || 0;
      if (s.ms_p50 != null) a.p50s.push(s.ms_p50);
      if (s.ms_p95 != null) a.p95s.push(s.ms_p95);
      if (s.ms_max != null) a.maxs.push(s.ms_max);
      a.failed += s.failed || 0;
      a.retries += s.retries || 0;
      a.returned += s.returned || 0;
      a.contributed += s.contributed || 0;
      a.unique += s.unique_contributed || 0;
      for (const [k, v] of Object.entries(s.failures || {})) a.failures[k] = (a.failures[k] || 0) + v;
      srcAgg.set(src, a);
    }
  }

  const rows = [...srcAgg.entries()].map(([src, a]) => ({
    src,
    role: a.role,
    calls: a.calls,
    perRun: (a.calls / a.runs).toFixed(1),
    p50: pct(a.p50s.sort((x, y) => x - y), 50),
    p95: pct(a.p95s.sort((x, y) => x - y), 95),
    max: a.maxs.length ? Math.max(...a.maxs) : null,
    failed: a.failed,
    retries: a.retries,
    failures: a.failures,
    returned: a.returned,
    contributed: a.contributed,
    unique: a.unique,
  })).sort((x, y) => (y.p95 || 0) - (x.p95 || 0));

  const w = Math.min(52, Math.max(20, ...rows.map((r) => r.src.length)));
  console.log(`\n## 端点稳定性(按 P95 降序 —— 最上面的就是瓶颈)\n`);
  console.log(`  ${pad('source', w)} ${lpad('调用', 5)} ${lpad('/次', 5)} ${lpad('P50', 8)} ${lpad('P95', 8)} ${lpad('最慢', 8)} ${lpad('失败', 5)} ${lpad('重试', 5)}`);
  console.log(`  ${'-'.repeat(w)} ${'-'.repeat(5)} ${'-'.repeat(5)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(5)} ${'-'.repeat(5)}`);
  for (const r of rows) {
    const spread = r.p50 && r.max ? (r.max / r.p50) : null;
    const flag = spread && spread >= 5 ? `  ← 方差 ${spread.toFixed(0)}x` : '';
    console.log(`  ${pad(r.src.slice(0, w), w)} ${lpad(r.calls, 5)} ${lpad(r.perRun, 5)} ${lpad(fmtMs(r.p50), 8)} ${lpad(fmtMs(r.p95), 8)} ${lpad(fmtMs(r.max), 8)} ${lpad(r.failed, 5)} ${lpad(r.retries, 5)}${flag}`);
  }

  // ---- 3. 查询浪费 ------------------------------------------------------
  // 只对 role=data 的 source 谈"浪费"。lookup 类(users 映射 / exec 归属 /
  // 产品名 / story 反查)的返回本就不进 payload,拿贡献度衡量它们会诱导
  // 人砍掉必需的查表。
  const dataRows = rows.filter((r) => r.role !== 'lookup');
  const lookupRows = rows.filter((r) => r.role === 'lookup');
  const totalMs = rows.reduce((n, r) => n + (r.p50 || 0) * r.calls, 0) || 1;
  const share = (r) => Math.round(((r.p50 || 0) * r.calls / totalMs) * 100);

  console.log(`\n## 查询浪费(独有贡献 = 砍掉这个取法会丢多少条数据)\n`);
  console.log(`  ${pad('source', w)} ${lpad('返回', 6)} ${lpad('进报告', 7)} ${lpad('独有', 6)} ${lpad('耗时占比', 9)}  结论`);
  console.log(`  ${'-'.repeat(w)} ${'-'.repeat(6)} ${'-'.repeat(7)} ${'-'.repeat(6)} ${'-'.repeat(9)}  ----`);
  for (const r of dataRows) {
    const sh = share(r);
    let verdict = '';
    if (r.calls === 0) verdict = `零额外调用(复用他人结果)`;
    else if (r.contributed === 0 && r.returned > 0) verdict = '⚠️ 返回的数据一条都没进报告';
    else if (r.unique === 0 && r.contributed > 0) verdict = `⚠️ 独有 0(全被其他取法覆盖)— 候选可砍`;
    else if (r.unique > 0 && r.unique <= 2 && sh >= 15) verdict = `独有仅 ${r.unique} 条却占 ${sh}% 耗时`;
    console.log(`  ${pad(r.src.slice(0, w), w)} ${lpad(r.returned, 6)} ${lpad(r.contributed, 7)} ${lpad(r.unique, 6)} ${lpad(`${sh}%`, 9)}  ${verdict}`);
  }
  if (lookupRows.length) {
    console.log(`\n  查表类(不产出报告数据,不参与浪费判定):`);
    for (const r of lookupRows) {
      console.log(`  ${pad(r.src.slice(0, w), w)} ${lpad(r.returned, 6)} ${lpad('-', 7)} ${lpad('-', 6)} ${lpad(`${share(r)}%`, 9)}`);
    }
  }
  // 样本的运行时刻分布 —— 判断上面那张表能不能代表 cron 的真实场景
  const hours = runs.map((r) => (new Date(r.started_at).getUTCHours() + 8) % 24);
  const hourSet = [...new Set(hours)].sort((a, b) => a - b);
  console.log(`\n  样本运行时刻(北京时间): ${hourSet.map((h) => `${String(h).padStart(2, '0')}:00`).join(' ')}`);
  console.log(`\n  注:独有贡献为 0 只是**候选**,不是结论。两条护栏:`);
  console.log(`     1. 采样时段决定结论。finishedDate 腿捕获的是"今日完成"的任务,`);
  console.log(`        中午跑时当天几乎没有任务完成,它的贡献天然为 0 —— 用非 cron`);
  console.log(`        时段的数据去判它"可砍",晚上就会丢掉整段"今日完成"。`);
  console.log(`        必须用 cron 实际运行时段(20:20)的样本判断。`);
  console.log(`     2. 需连续多日为 0 才可动,且应先进影子验证而非直接改。`);
  console.log(`        砍错的代价是静默丢数据,这个 skill 已经栽过多次。`);
  console.log(`     3. 本列只评估「单独砍一条」。三腿高度重叠时可能各自独有都是 0`);
  console.log(`        (任一条被砍其余仍覆盖),但**同时砍两条就会丢数据**。`);
  console.log(`        多条一起砍必须实跑候选策略比对结果集,静态指标推不出来。`);

  // ---- 4. 失败归因 ------------------------------------------------------
  const allFailures = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.failures)) allFailures[k] = (allFailures[k] || 0) + v;
  if (Object.keys(allFailures).length) {
    console.log(`\n## 失败归因\n`);
    for (const [k, v] of Object.entries(allFailures).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pad(k, 14)} ${v} 次`);
    }
  }

  // ---- 5. 时段相关性 ----------------------------------------------------
  // 明细日志里带 UTC 时间戳,按小时聚合能验证"慢窗"假设。
  const dates = [...new Set(runs.map((r) => r.date))];
  const byHour = new Map();
  for (const d of dates) {
    for (const rec of readJsonl(path.join(dir, `requests-${d}.jsonl`))) {
      if (!rec.ms) continue;
      const h = new Date(rec.t).getUTCHours();
      const cst = (h + 8) % 24; // Asia/Shanghai
      const a = byHour.get(cst) || { ms: [], timeouts: 0, n: 0 };
      a.ms.push(rec.ms);
      a.n++;
      if (rec.failure === 'timeout') a.timeouts++;
      byHour.set(cst, a);
    }
  }
  if (byHour.size) {
    console.log(`\n## 时段相关性(北京时间,验证「慢窗」假设)\n`);
    console.log(`  ${lpad('时段', 6)} ${lpad('请求', 6)} ${lpad('P50', 8)} ${lpad('P95', 8)} ${lpad('超时', 5)}`);
    for (const [h, a] of [...byHour.entries()].sort((x, y) => x[0] - y[0])) {
      const s = a.ms.sort((x, y) => x - y);
      const flag = a.timeouts ? '  ⚠️' : '';
      console.log(`  ${lpad(`${String(h).padStart(2, '0')}:00`, 6)} ${lpad(a.n, 6)} ${lpad(fmtMs(pct(s, 50)), 8)} ${lpad(fmtMs(pct(s, 95)), 8)} ${lpad(a.timeouts, 5)}${flag}`);
    }
  }

  // ---- 6. 基线偏离 ------------------------------------------------------
  if (runs.length >= 3) {
    const latest = runs[runs.length - 1];
    const history = runs.slice(0, -1);
    console.log(`\n## 最近一次 vs 历史基线(中位数)\n`);
    let any = false;
    for (const [src, s] of Object.entries(latest.by_source || {})) {
      const vals = history.map((r) => (r.by_source || {})[src]).filter(Boolean)
        .map((x) => x.ms_p95).filter((v) => typeof v === 'number').sort((a, b) => a - b);
      if (!vals.length || s.ms_p95 == null) continue;
      const base = pct(vals, 50);
      const delta = Math.round(((s.ms_p95 - base) / base) * 100);
      if (Math.abs(delta) < 30) continue;
      any = true;
      console.log(`  ${pad(src.slice(0, w), w)} ${fmtMs(base)} → ${fmtMs(s.ms_p95)}  ${delta > 0 ? '+' : ''}${delta}%${delta > 80 ? '  ⚠️' : ''}`);
    }
    if (!any) console.log('  (无显著偏离,±30% 以内)');
  }

  console.log('');
}

main();
