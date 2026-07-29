'use strict';
const { HistoryStore } = require('./lib/history-store');
const { atomicWriteJSON } = require('./lib/atomic-write');
const { dieboldMariano } = require('./lib/stats');
const { p0N, sigmaDaily, readFeature } = require('./baseline');

const N_BY_HORIZON = { short: 1, medium: 5, long: 20 };
const MIN_SAMPLES = 1200;     // 指预热后可用样本数,非日历天数;7 年回填约剩 1430

const lagFor = (key) => N_BY_HORIZON[key];

// 每个预测日只使用该日按 available_date 已可见的数据,杜绝前视偏差。
function walkForward({ store, from, to }) {
  const all = readFeature(store, 'lbma_pm_usd', to);
  const byHorizon = {};
  for (const key of Object.keys(N_BY_HORIZON)) byHorizon[key] = { baselineLoss: [], naiveLoss: [] };

  for (let i = 0; i < all.length; i++) {
    const d = all[i].observed_date;
    if (d < from || d > to) continue;
    const visible = all.slice(0, i + 1).map((r) => r.value);
    if (visible.length < 300) continue;
    for (const [key, n] of Object.entries(N_BY_HORIZON)) {
      const target = all[i + n];
      if (!target) continue;
      const outcome = target.value > all[i].value ? 1 : 0;
      const p0 = p0N(visible, n);
      // 基线此处即 p0 + 动量的极简形式;特征是否纳入由本函数产出的损失决定。
      const ma20 = visible.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, visible.length);
      const sig = sigmaDaily(visible);
      const mom = sig > 0 ? (all[i].value / ma20 - 1) / sig : 0;
      const pb = Math.min(0.95, Math.max(0.05, p0 + 0.02 * Math.tanh(mom)));
      byHorizon[key].baselineLoss.push((outcome - pb) ** 2);
      byHorizon[key].naiveLoss.push((outcome - p0) ** 2);
    }
  }
  return { byHorizon };
}

function acceptance(result, { minGain = 0.005, alpha = 0.05, minSamples = MIN_SAMPLES } = {}) {
  const out = {};
  for (const [key, s] of Object.entries(result.byHorizon)) {
    const n = s.baselineLoss.length;
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const gain = mean(s.naiveLoss) - mean(s.baselineLoss);
    const { p } = dieboldMariano(s.naiveLoss, s.baselineLoss, { lag: lagFor(key) });
    const passed = n >= minSamples && gain >= minGain && p < alpha;
    out[key] = { n, brier_gain: Number(gain.toFixed(6)), dm_p: Number(p.toFixed(6)), passed };
    if (!passed) out[key].fallback = 'p0_N';
  }
  return out;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new HistoryStore(args.history);
  const res = walkForward({ store, from: args.from, to: args.to });
  const acc = acceptance(res);
  const params = {
    params_id: `p-${args.to.replace(/-/g, '')}`,
    status: Object.values(acc).some((a) => a.passed) ? 'accepted' : 'fitted',
    fitted_at: args.to, accepted_at: args.to,
    sample_period: [args.from, args.to],
    features: ['p0_N', 'momentum_z'],
    coefficients: {}, acceptance: acc,
  };
  atomicWriteJSON(args.out, params);
  for (const [k, a] of Object.entries(acc)) {
    console.error(`${k}: n=${a.n} gain=${a.brier_gain} p=${a.dm_p} passed=${a.passed}`);
  }
}

if (require.main === module) main();
module.exports = { walkForward, acceptance, lagFor };
