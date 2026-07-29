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

  // 防前视必须在读价之前:--today 回放时 priceByDate 会含 today 之后的价,
  // 守卫放在 exact 分支之后就会拿未来价把三期一次性结掉(与 availableOn 纪律同源)。
  if (ctx.today && ctx.today < h.target_date) return false;

  const exact = ctx.priceByDate[h.target_date];
  if (exact !== undefined) {
    applySettlement(h, base_price, h.target_date, exact, 'exact', ctx);
    return true;
  }
  if (ctx.today <= h.target_date) return false;   // 目标日当天价未出,正常 pending

  // 逾期:用其后第一个可得定盘价结算,而不是直接丢弃 —— 静默排除会让统计偏乐观。
  const later = Object.keys(ctx.priceByDate)
    .filter((d) => d > h.target_date && (!ctx.today || d <= ctx.today)).sort();
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

const finiteOrUndef = (v) => (Number.isFinite(v) ? v : undefined);

// 优先用预测时冻结在 horizon 上的 naive_p:db 级 naive_p 每天被覆盖,
// 一条 T+20 在 20 多个交易日后结算时读到的窗口已含被预测的那段行情,
// 等于无信息基准偷看了答案。按 finite 而非真值判定,合法概率 0 不得被当成缺失。
function resolveNaiveP(h, ctx) {
  const frozen = finiteOrUndef(h.naive_p);
  if (frozen !== undefined) return { naive_p: frozen, naive_p_source: 'frozen' };
  const live = finiteOrUndef(ctx.naiveP ? ctx.naiveP[h.n_sessions] : undefined);
  if (live !== undefined) return { naive_p: live, naive_p_source: 'db' };
  return { naive_p: 0.5, naive_p_source: 'fallback' };
}

function applySettlement(h, base_price, date, actual, kind, ctx) {
  const { naive_p, naive_p_source } = resolveNaiveP(h, ctx);
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
    // 落盘留痕:否则 naive_brier=0.25 分不清是真算出 0.5 还是回退兜底
    naive_p, naive_p_source,
  };
}

function settleAll(predictions, ctx) {
  let changed = 0;
  const naiveFallback = [];
  for (const p of predictions) {
    for (const key of ['short', 'medium', 'long']) {
      const h = p.horizons[key];
      if (!settleHorizon(h, p.base_price, ctx)) continue;
      changed++;
      if (h.score && h.score.naive_p_source === 'fallback') naiveFallback.push(`${p.id}/${key}`);
    }
  }
  return { predictions, changed, naiveFallback };
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

  const { changed, naiveFallback } = settleAll(db.predictions, {
    priceByDate,
    today: args.today || sp.latest.date,
    naiveP: db.naive_p || null,
  });
  atomicWriteJSON(args.predictions, db);
  console.error(`结算完成,更新 ${changed} 个 horizon`);
  if (naiveFallback.length) {
    console.error(`警告: ${naiveFallback.length} 个 horizon 无 naive_p 可用,已回退 0.5(基准被抬高,回测增益会虚高): ${naiveFallback.slice(0, 5).join(', ')}`);
  }
}

if (require.main === module) main();
module.exports = { scoreOne, settleAll, settleHorizon, resolveNaiveP };
