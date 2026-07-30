'use strict';
const fs = require('node:fs');
const { HistoryStore } = require('./lib/history-store');
const { atomicWriteJSON } = require('./lib/atomic-write');
const { normInv, predictLogistic, assertAllFinite } = require('./lib/stats');

const Z80 = normInv(0.9);
const SIGMA_WINDOW = 20;
const TRAIN_WINDOW = 250;
const N_BY_HORIZON = { short: 1, medium: 5, long: 20 };
const COT_PCTILE_MIN_SAMPLES = 20;
// logistic 的特征顺序即 coefficients 的下标顺序,backtest 与本文件共用这一个常量,
// 两端各写一份必然漂移(v1 就是 backtest 声明 p0_N/momentum_z、serve 却跑三特征)。
const MODEL_FEATURES = ['momentum_z', 'real_yield_chg', 'cot_pctile'];

function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) out.push(Math.log(prices[i] / prices[i - 1]));
  return out;
}

// 只剩 1 个价格点时 logReturns 为空,空 reduce 的初值 0 会把 NaN 吃掉而返回 0,
// 后续所有判空全部失效,对外输出「80% 把握价格恰为 3000.00」的零宽区间。
function sigmaDaily(prices, window = SIGMA_WINDOW) {
  const r = logReturns(prices).slice(-window);
  if (r.length < 2) {
    throw new Error(`sigmaDaily 需至少 3 个价格点以形成 2 个对数收益,实得 ${prices.length} 个价格点`);
  }
  assertAllFinite(r, 'sigmaDaily 对数收益');
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1));
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

// 两端都必须是有限数才相减:落盘过 null 的行相减得 0(`null - null === 0`),
// Number.isFinite(0) 为真 ⇒ degraded_features 判它健康、常数 0 被当成「今日实际利率没变」
// 服务出去,而这正是 FRED 回填形态出错时的表现。
function realYieldChg(rows) {
  if (rows.length < 2) return null;
  const prev = rows[rows.length - 2].value;
  const last = rows[rows.length - 1].value;
  return Number.isFinite(prev) && Number.isFinite(last) ? last - prev : null;
}

// --params 是绕开 asOf 的第二条数据通路:样本期跨到 asOf 之后就意味着系数见过未来。
// 宁可整包丢弃退回 p0,也不静默服务;拒绝理由必须落进产物,否则输出上毫无痕迹。
function validateParams(params, asOf) {
  if (!params) return { params: null, rejected: null };
  const reject = (reason) => ({
    params: null,
    rejected: { reason, sample_period: params.sample_period ?? null, as_of: asOf },
  });
  const sp = params.sample_period;
  if (!Array.isArray(sp) || sp.length !== 2 || typeof sp[1] !== 'string') {
    return reject('sample_period 缺失或格式非法,无法证明系数未用未来数据');
  }
  if (sp[1] > asOf) return reject('sample_period 结束日晚于 as-of,系数含未来数据');
  return { params, rejected: null };
}

function computeBaseline({ store, asOf, params: rawParams }) {
  const { params, rejected } = validateParams(rawParams, asOf);
  const priceRows = readFeature(store, 'lbma_pm_usd', asOf);
  if (priceRows.length === 0) throw new Error(`无可用价格历史: lbma_pm_usd as of ${asOf}`);
  const prices = priceRows.map((r) => r.value);
  const basePrice = prices[prices.length - 1];
  const sigma = sigmaDaily(prices);
  if (!(sigma > 0)) throw new Error(`日波动率为 0(价格 ${SIGMA_WINDOW} 日无变化),区间将退化为零宽: as of ${asOf}`);

  const cot = readFeature(store, 'cftc_gold', asOf);
  const dfii = readFeature(store, 'fred_DFII10', asOf);

  const ma20 = prices.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, prices.length);
  const features = {
    p0_1: p0N(prices, 1), p0_5: p0N(prices, 5), p0_20: p0N(prices, 20),
    momentum_z: (basePrice / ma20 - 1) / sigma,
    // 取不到就是 null,不再用 0 冒充「今天实际利率没变」
    real_yield_chg: realYieldChg(dfii),
    cot_pctile: cotPctile(cot),
  };
  // 降级清单直接由模型特征派生,不再手写一份判据 —— 判据与清单分家就会漂移
  const degraded = MODEL_FEATURES.filter((f) => !Number.isFinite(features[f]));

  const horizons = {};
  for (const [key, n] of Object.entries(N_BY_HORIZON)) {
    const p0 = features[`p0_${n}`];
    // 未过验收的周期不发系数;有特征缺失时同样退回 p0 ——
    // 插补 0.5 再照跑会把纯插补值输出成 prob_up=0.99 的高置信信号
    const coef = params && params.coefficients && params.coefficients[key];
    const useLogistic = Boolean(coef) && degraded.length === 0;
    const prob = useLogistic ? predictLogistic(coef, MODEL_FEATURES.map((f) => features[f])) : p0;
    horizons[key] = {
      prob_up: Number(prob.toFixed(4)),
      model: useLogistic ? 'logistic' : 'p0_N',
      ...intervalFor(basePrice, sigma, n),
    };
    if (coef && !useLogistic) horizons[key].degraded_reason = `特征缺失: ${degraded.join(',')}`;
  }

  return {
    params_id: params ? params.params_id : null,
    params_rejected: rejected,
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
  if (out.params_rejected) console.error(`WARN 参数集被拒: ${out.params_rejected.reason},本次退回 p0_N`);
  if (out.degraded_features.length) console.error(`WARN 特征降级: ${out.degraded_features.join(',')},本次退回 p0_N`);
  // 按不变量报而非按原因枚举:params.json 缺失、系数为空、被拒、特征降级四种情形
  // 此前只有后两种会 WARN,前两种与健康运行在 stderr 与退出码上逐字相同 ——
  // 「量化基线整个没上线」与「完全正常」外观一致,是让 FRED 回填故障不可观察的放大器。
  const fellBack = Object.keys(out.horizons).filter((k) => out.horizons[k].model === 'p0_N');
  if (fellBack.length) {
    console.error(`WARN 未跑 logistic 的周期: ${fellBack.join(',')}(params_id=${out.params_id || '无'})`);
  }
  console.error(`基线 ${out.base_date} base=${out.base_price} σ=${out.sigma_d}`);
}

if (require.main === module) main();
module.exports = {
  MODEL_FEATURES, N_BY_HORIZON, COT_PCTILE_MIN_SAMPLES,
  sigmaDaily, p0N, intervalFor, readFeature, cotPctile, realYieldChg, validateParams, computeBaseline,
};
