'use strict';
const fs = require('node:fs');
const { atomicWriteJSON } = require('./lib/atomic-write');

const ALPHA = 0.2;
const APPROX_WINDOW_DAYS = 30;

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

// 单条 Brier 是 (outcome - p)^2;聚合式 p(1-p) 属 scorecard,两者混用会让基准整体偏移。
function scoreOne({ prob_up, low, high, base_price, actual, naive_p }) {
  const outcome = actual > base_price ? 1 : 0;
  const winkler = (high - low)
    + (actual < low ? (2 / ALPHA) * (low - actual) : 0)
    + (actual > high ? (2 / ALPHA) * (actual - high) : 0);
  return {
    dir_correct: (prob_up > 0.5) === (outcome === 1),
    brier: Math.pow(outcome - prob_up, 2),
    naive_brier: Math.pow(outcome - naive_p, 2),
    in_range: actual >= low && actual <= high,
    winkler,
  };
}

function settleHorizon(h, base_price, ctx) {
  if (h.settled || h.status === 'abandoned') return false;

  const exact = ctx.priceByDate[h.target_date];
  if (exact !== undefined) {
    applySettlement(h, base_price, h.target_date, exact, 'exact', ctx);
    return true;
  }
  if (ctx.today <= h.target_date) return false;   // 目标日未到,正常 pending

  // 逾期:用其后第一个可得定盘价结算,而不是直接丢弃 —— 静默排除会让统计偏乐观。
  const later = Object.keys(ctx.priceByDate).filter((d) => d > h.target_date).sort();
  if (later.length > 0 && daysBetween(h.target_date, later[0]) <= APPROX_WINDOW_DAYS) {
    applySettlement(h, base_price, later[0], ctx.priceByDate[later[0]], 'approx', ctx);
    return true;
  }
  if (daysBetween(h.target_date, ctx.today) > APPROX_WINDOW_DAYS) {
    h.status = 'abandoned';
    return true;
  }
  return false;
}

function applySettlement(h, base_price, date, actual, kind, ctx) {
  const naive_p = ctx.naiveP ? ctx.naiveP[h.n_sessions] || 0.5 : 0.5;
  const f = scoreOne({ ...h.final, base_price, actual, naive_p });
  const b = scoreOne({ ...h.baseline, base_price, actual, naive_p });
  h.settled = true;
  h.settled_date = date;
  h.settled_kind = kind;
  h.actual = actual;
  h.score = {
    dir_correct: f.dir_correct, brier: f.brier,
    in_range: f.in_range, winkler: f.winkler,
    baseline_brier: b.brier, baseline_winkler: b.winkler,
    baseline_dir_correct: b.dir_correct, naive_brier: f.naive_brier,
  };
}

function settleAll(predictions, ctx) {
  let changed = 0;
  for (const p of predictions) {
    for (const key of ['short', 'medium', 'long']) {
      if (settleHorizon(p.horizons[key], p.base_price, ctx)) changed++;
    }
  }
  return { predictions, changed };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = JSON.parse(fs.readFileSync(args.predictions, 'utf-8'));
  const sp = JSON.parse(fs.readFileSync(args.settlement, 'utf-8'));
  const priceByDate = {};
  for (const row of sp.history || []) priceByDate[row.date] = row.value;
  if (sp.latest) priceByDate[sp.latest.date] = sp.latest.value;

  const { changed } = settleAll(db.predictions, {
    calendar: sp.calendar_tail || [],
    priceByDate,
    today: args.today || sp.latest.date,
    naiveP: db.naive_p || null,
  });
  atomicWriteJSON(args.predictions, db);
  console.error(`结算完成,更新 ${changed} 个 horizon`);
}

if (require.main === module) main();
module.exports = { scoreOne, settleAll, settleHorizon };
