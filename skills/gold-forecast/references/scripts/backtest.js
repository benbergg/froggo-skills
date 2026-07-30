'use strict';
const { HistoryStore } = require('./lib/history-store');
const { atomicWriteJSON } = require('./lib/atomic-write');
const { dieboldMariano, fitLogistic, predictLogistic, assertAllFinite } = require('./lib/stats');
const { p0N, sigmaDaily, readFeature, cotPctile, realYieldChg,
  MODEL_FEATURES, N_BY_HORIZON } = require('./baseline');

// 指真正进入评估的样本数,非日历天数。卡住样本量的不是 LBMA spine —— 它是全量历史
// (lbma-gold-pm 不按 since 过滤),WARMUP 由它白白吃掉、不占预算。真正的预算是
// **三特征同时可用的那段窗口**,由 backfill 的 --since 决定(COT 按日历年整年取,
// FRED 按 realtime_start=since)。该窗口内还要先耗掉两段烧机:
//   COT 分位需 20 期周频 ≈ 95 个交易日,再叠 MIN_TRAIN 条训练样本。
// 故第 n 期可评估条数 = 覆盖窗口 - 95 - MIN_TRAIN - 2n,long(n=20)要凑够 1200 条
// 需约 1585 个交易日 ≈ 6.3 年覆盖(实测 6.0 年只剩 1115)。因 COT 按整年取,
// --since 建议留到 --until 前 7 个完整日历年。不足时 acceptance 会给出 samples_short_by。
const MIN_SAMPLES = 1200;
const WARMUP = 300;           // p0N 需 250+n 根,sigmaDaily 需 20 根
const MIN_TRAIN = 250;        // logistic 拟合样本下限,约每参数 62 条
// 每 63 个交易日(约一季度)重拟合一次。日频重拟合是 1760 次 IRLS × 上千行,
// 端到端要几十分钟;季度节奏把成本降到 1/60,而系数在这个尺度上本就不该抖。
const REFIT_EVERY = 63;
// walk-forward 早期训练窗口小、易线性可分,ridge 1e-6 会收敛不了直接中止整条回测。
// 不做标准化:标准化参数会变成 serve 端契约的一部分,而 baseline 只喂原始特征。
const FIT_OPTS = { iters: 100, ridge: 1e-4 };

const lagFor = (key) => N_BY_HORIZON[key];

// 按 available_date 增量推进的可见性游标。语义与 HistoryStore.read(series,{availableOn:d})
// 逐日等价(由 run-backtest-tests 的逐日对拍锁住),但把「每天重读重解析整个 jsonl」的
// O(天数×行数) 降成一次全量读 + 增量插入 —— 为性能重新引入前视才是这里真正的风险。
class VisibilityCursor {
  constructor(store, series) {
    const rows = store.readAll(series);
    for (const r of rows) {
      if (typeof r.available_date !== 'string') {
        throw new Error(`${series} 存在缺 available_date 的记录,无法判定可见性: ${JSON.stringify(r)}`);
      }
    }
    // HistoryStore 同 observed_date 取 available_date 最大者,相等时保留文件里先出现的那条
    // (它用严格 >)。故按 (available_date, 文件序) 升序摄入 + 严格 > 替换,并列规则才一致。
    this._pending = rows.map((r, idx) => ({ r, idx })).sort((a, b) => (
      a.r.available_date < b.r.available_date ? -1
        : a.r.available_date > b.r.available_date ? 1
          : a.idx - b.idx
    ));
    this._pos = 0;
    this._byObserved = new Map();
    this.rows = [];
    this.values = [];
  }

  // date 必须单调不减
  advanceTo(date) {
    while (this._pos < this._pending.length && this._pending[this._pos].r.available_date <= date) {
      const r = this._pending[this._pos++].r;
      const cur = this._byObserved.get(r.observed_date);
      if (cur === undefined) this._insert(r);
      else if (r.available_date > cur.available_date) this._replace(r);
    }
  }

  get(observedDate) { return this._byObserved.get(observedDate); }

  _slot(observedDate) {
    let lo = 0, hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rows[mid].observed_date < observedDate) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  _insert(r) {
    const at = this._slot(r.observed_date);
    this.rows.splice(at, 0, r);
    this.values.splice(at, 0, r.value);
    this._byObserved.set(r.observed_date, r);
  }

  _replace(r) {
    const at = this._slot(r.observed_date);
    this.rows[at] = r;
    this.values[at] = r.value;
    this._byObserved.set(r.observed_date, r);
  }
}

// 结算日视角的真实涨跌。用结算当日可见的版本判定,而非窗口末端的终版 ——
// 否则窗口内后发的修订会倒流回更早的样本,前视从「特征」搬到「标签」上继续存在。
function realizedOutcomes(store, spine) {
  const cursor = new VisibilityCursor(store, 'lbma_pm_usd');
  const out = {};
  for (const key of Object.keys(N_BY_HORIZON)) out[key] = new Map();
  for (let s = 0; s < spine.length; s++) {
    cursor.advanceTo(spine[s]);
    const target = cursor.get(spine[s]);
    if (!target) continue;
    for (const [key, n] of Object.entries(N_BY_HORIZON)) {
      const i = s - n;
      if (i < 0) continue;
      const base = cursor.get(spine[i]);
      if (!base) continue;
      out[key].set(i, target.value > base.value ? 1 : 0);
    }
  }
  return out;
}

// 逐日快照:每个预测日按 available_date 已可见的数据算出的三特征与三个 p0。
// 只留标量,不留价格数组 —— cursor.values 是原地增长的同一个数组,存引用等于
// 隔天回看时拿到未来的价格。
function dailyView(store, spine, warmup) {
  const price = new VisibilityCursor(store, 'lbma_pm_usd');
  const dfii = new VisibilityCursor(store, 'fred_DFII10');
  const cot = new VisibilityCursor(store, 'cftc_gold');
  const out = new Map();
  for (let i = 0; i < spine.length; i++) {
    price.advanceTo(spine[i]);
    dfii.advanceTo(spine[i]);
    cot.advanceTo(spine[i]);
    if (i < warmup || price.values.length < warmup) continue;
    const prices = price.values;
    const basePrice = prices[prices.length - 1];
    const ma20 = prices.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, prices.length);
    const sigma = sigmaDaily(prices);
    const dfiiRows = dfii.rows;
    const f = {
      momentum_z: sigma > 0 ? (basePrice / ma20 - 1) / sigma : null,
      real_yield_chg: realYieldChg(dfiiRows),
      cot_pctile: cotPctile(cot.rows),
    };
    const x = MODEL_FEATURES.map((k) => f[k]);
    const p0 = {};
    for (const [key, n] of Object.entries(N_BY_HORIZON)) p0[key] = p0N(prices, n);
    out.set(i, { x, p0, ok: x.every(Number.isFinite) });
  }
  return out;
}

// 拟合并验证 baseline 实际服务的那个三特征 logistic。
// 每个预测日只读该日按 available_date 已可见的数据;系数只用结算日严格早于该日的样本拟合。
function walkForward({ store, from, to, warmup = WARMUP, minTrain = MIN_TRAIN, refitEvery = REFIT_EVERY }) {
  const spine = readFeature(store, 'lbma_pm_usd', to).map((r) => r.observed_date).filter((d) => d <= to);
  const outcomes = realizedOutcomes(store, spine);
  const daily = dailyView(store, spine, warmup);

  const byHorizon = {};
  const state = {};
  for (const key of Object.keys(N_BY_HORIZON)) {
    byHorizon[key] = { baselineLoss: [], naiveLoss: [], dates: [] };
    state[key] = { coef: null, lastFitAt: -Infinity, trainX: [], trainY: [], fitted: 0 };
  }
  const diag = { evaluated: 0, skipped_warmup: 0, skipped_degraded: 0, skipped_no_model: 0, skipped_no_outcome: 0 };

  for (let i = 0; i < spine.length; i++) {
    const d = spine[i];
    for (const [key, n] of Object.entries(N_BY_HORIZON)) {
      const st = state[key];
      // 唯一的 walk-forward 边界:结算日须严格早于今天,即 spine[j+n] < spine[i] ⇔ j < i-n
      const eligible = i - n - 1;
      const row = daily.get(eligible);
      if (row && row.ok && outcomes[key].has(eligible)) {
        st.trainX.push(row.x);
        st.trainY.push(outcomes[key].get(eligible));
      }
      if (st.trainX.length >= minTrain && (st.coef === null || i - st.lastFitAt >= refitEvery)) {
        st.coef = fitLogistic(st.trainX, st.trainY, FIT_OPTS);
        st.lastFitAt = i;
        st.fitted++;
      }

      if (d < from) continue;
      const cur = daily.get(i);
      if (!cur) { diag.skipped_warmup++; continue; }
      if (!outcomes[key].has(i)) { diag.skipped_no_outcome++; continue; }
      if (!cur.ok) { diag.skipped_degraded++; continue; }
      if (st.coef === null) { diag.skipped_no_model++; continue; }

      const outcome = outcomes[key].get(i);
      const pb = predictLogistic(st.coef, cur.x);
      assertAllFinite([cur.p0[key], pb], `${key} ${d} 概率`);
      byHorizon[key].baselineLoss.push((outcome - pb) ** 2);
      byHorizon[key].naiveLoss.push((outcome - cur.p0[key]) ** 2);
      byHorizon[key].dates.push(d);
      diag.evaluated++;
    }
  }

  const coefficients = {};
  for (const [key, st] of Object.entries(state)) if (st.coef) coefficients[key] = st.coef;
  const refits = Object.fromEntries(Object.entries(state).map(([k, s]) => [k, s.fitted]));
  return { byHorizon, coefficients, features: MODEL_FEATURES, diagnostics: { ...diag, refits } };
}

function acceptance(result, { minGain = 0.005, alpha = 0.05, minSamples = MIN_SAMPLES } = {}) {
  const out = {};
  for (const [key, s] of Object.entries(result.byHorizon)) {
    if (s.baselineLoss.length !== s.naiveLoss.length) {
      throw new Error(`${key} 两侧损失长度不等(${s.baselineLoss.length} vs ${s.naiveLoss.length}),`
        + '按不同长度取均值算增益等于拿两个不同样本比大小');
    }
    assertAllFinite(s.baselineLoss, `${key} baselineLoss`);
    assertAllFinite(s.naiveLoss, `${key} naiveLoss`);
    const n = s.baselineLoss.length;
    if (n === 0) {
      out[key] = { n: 0, brier_gain: null, dm_p: null, checks: { samples: false, gain: false, significance: false },
        passed: false, fallback: 'p0_N' };
      continue;
    }
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const gain = mean(s.naiveLoss) - mean(s.baselineLoss);
    const { p } = dieboldMariano(s.naiveLoss, s.baselineLoss, { lag: lagFor(key) });
    // 三个条件各自留痕:只看 passed 的话,「样本不够」造成的不通过会被误当成
    // 「显著性不够」,自检里也就写不出真正只让某一条为假的用例
    const checks = { samples: n >= minSamples, gain: gain >= minGain, significance: p < alpha };
    const passed = checks.samples && checks.gain && checks.significance;
    out[key] = { n, brier_gain: Number(gain.toFixed(6)), dm_p: Number(p.toFixed(6)), checks, passed };
    // 差多少条要写出来:否则「回填窗口不够」和「模型没信号」在产物上长得一模一样
    if (!checks.samples) out[key].samples_short_by = minSamples - n;
    if (!passed) out[key].fallback = 'p0_N';
  }
  return out;
}

// 只有验收通过的周期才发系数;未通过的周期不出现在 coefficients 里,
// baseline 取不到就自动退回 p0_N —— 靠数据结构断路,不靠调用方自觉看 status。
function buildParams({ from, to, result, acc }) {
  const passedKeys = Object.keys(acc).filter((k) => acc[k].passed);
  const coefficients = {};
  for (const k of passedKeys) coefficients[k] = result.coefficients[k];
  const total = Object.keys(acc).length;
  const status = passedKeys.length === total ? 'accepted' : passedKeys.length ? 'partial' : 'fitted';
  return {
    params_id: `p-${to.replace(/-/g, '')}`,
    status,
    fitted_at: to,
    accepted_at: passedKeys.length ? to : null,
    sample_period: [from, to],
    features: result.features,
    coefficients,
    acceptance: acc,
    diagnostics: result.diagnostics,
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
  const res = walkForward({ store, from: args.from, to: args.to });
  const acc = acceptance(res);
  const params = buildParams({ from: args.from, to: args.to, result: res, acc });
  atomicWriteJSON(args.out, params);
  const dg = res.diagnostics;
  console.error(`样本 评估=${dg.evaluated} 降级跳过=${dg.skipped_degraded} 无模型跳过=${dg.skipped_no_model}`
    + ` 重拟合=${JSON.stringify(dg.refits)}`);
  for (const [k, a] of Object.entries(acc)) {
    console.error(`${k}: n=${a.n} gain=${a.brier_gain} p=${a.dm_p} checks=${JSON.stringify(a.checks)} passed=${a.passed}`);
  }
  console.error(`status=${params.status} 发系数周期=[${Object.keys(params.coefficients).join(',')}]`);
}

if (require.main === module) main();
module.exports = {
  walkForward, acceptance, buildParams, lagFor, realizedOutcomes, dailyView, VisibilityCursor,
  MIN_SAMPLES, WARMUP, MIN_TRAIN, REFIT_EVERY, FIT_OPTS,
};
