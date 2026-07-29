'use strict';
const fs = require('node:fs');
const { HistoryStore } = require('./lib/history-store');
const { atomicWriteJSON } = require('./lib/atomic-write');
const { normInv, predictLogistic } = require('./lib/stats');

const Z80 = normInv(0.9);
const SIGMA_WINDOW = 20;
const TRAIN_WINDOW = 250;
const N_BY_HORIZON = { short: 1, medium: 5, long: 20 };
const COT_PCTILE_MIN_SAMPLES = 20;

function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) out.push(Math.log(prices[i] / prices[i - 1]));
  return out;
}

function sigmaDaily(prices, window = SIGMA_WINDOW) {
  const r = logReturns(prices).slice(-window);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, r.length - 1));
}

// 按周期分别估计;重叠窗口自相关,显著性检验需 Newey-West 修正
function p0N(prices, n, window = TRAIN_WINDOW) {
  const px = prices.slice(-(window + n));
  let up = 0, total = 0;
  for (let i = 0; i + n < px.length; i++) { total++; if (px[i + n] > px[i]) up++; }
  return total ? up / total : 0.5;
}

function intervalFor(basePrice, sigma, n) {
  const half = Z80 * sigma * Math.sqrt(n);
  const low = basePrice * Math.exp(-half);
  const high = basePrice * Math.exp(half);
  return { low: Number(low.toFixed(2)), high: Number(high.toFixed(2)),
           half_width: Number(((high - low) / 2).toFixed(2)) };
}

// 一切历史读取都按 availableOn 截断 —— 这是防前视偏差的唯一入口。
function readFeature(store, series, asOf) {
  return store.read(series, { availableOn: asOf });
}

// 净多分位(拥挤度);样本<20 无统计意义,与 collect-facts 判据同源但独立实现
function cotPctile(cotRows, minSamples = COT_PCTILE_MIN_SAMPLES) {
  const series = cotRows.map((r) => r.value && r.value.net_spec).filter((v) => typeof v === 'number');
  if (series.length < minSamples) return null;
  const current = series[series.length - 1];
  return series.filter((v) => v <= current).length / series.length;
}

function computeBaseline({ store, asOf, params }) {
  const priceRows = readFeature(store, 'lbma_pm_usd', asOf);
  if (priceRows.length === 0) throw new Error(`无可用价格历史: lbma_pm_usd as of ${asOf}`);
  const prices = priceRows.map((r) => r.value);
  const basePrice = prices[prices.length - 1];
  const sigma = sigmaDaily(prices);

  const cot = readFeature(store, 'cftc_gold', asOf);
  const dfii = readFeature(store, 'fred_DFII10', asOf);
  const cotPct = cotPctile(cot);
  const degraded = [];
  if (cotPct === null) degraded.push('cot_pctile');
  if (dfii.length < 2) degraded.push('real_yield_chg');

  const ma20 = prices.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, prices.length);
  const features = {
    p0_1: p0N(prices, 1), p0_5: p0N(prices, 5), p0_20: p0N(prices, 20),
    momentum_z: sigma > 0 ? (basePrice / ma20 - 1) / sigma : 0,
    real_yield_chg: dfii.length >= 2 ? dfii[dfii.length - 1].value - dfii[dfii.length - 2].value : 0,
    cot_pctile: cotPct,
  };

  const horizons = {};
  for (const [key, n] of Object.entries(N_BY_HORIZON)) {
    const p0 = features[`p0_${n}`];
    // 未过验收的参数集退化为纯 p0+波动率区间,不假装聪明
    const coef = params && params.coefficients && params.coefficients[key];
    const prob = coef
      ? predictLogistic(coef, [features.momentum_z, features.real_yield_chg, features.cot_pctile ?? 0.5])
      : p0;
    horizons[key] = { prob_up: Number(prob.toFixed(4)), ...intervalFor(basePrice, sigma, n) };
  }

  return {
    params_id: params ? params.params_id : null,
    base_date: priceRows[priceRows.length - 1].observed_date,
    base_price: basePrice,
    sigma_d: Number(sigma.toFixed(6)),
    features, horizons, degraded_features: degraded,
  };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new HistoryStore(args.history);
  const params = args.params && fs.existsSync(args.params)
    ? JSON.parse(fs.readFileSync(args.params, 'utf-8')) : null;
  const out = computeBaseline({ store, asOf: args['as-of'], params });
  atomicWriteJSON(args.out, out);
  console.error(`基线 ${out.base_date} base=${out.base_price} σ=${out.sigma_d}`);
}

if (require.main === module) main();
module.exports = { sigmaDaily, p0N, intervalFor, readFeature, computeBaseline };
