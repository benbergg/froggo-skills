'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshTmp } = require('./helpers');
const { HistoryStore } = require('../references/scripts/lib/history-store');
const B = require('../references/scripts/baseline');

// 造一段带正漂移的价格序列
function seedPrices(store, n = 400, start = '2025-01-01') {
  const recs = [];
  let px = 3000;
  const d = new Date(start + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    // 振幅 0.012>漂移贡献,否则任何 20 日窗口都必涨,p0_20 恒为 1,T8 的非退化断言无法满足
    px *= 1 + 0.0006 + 0.012 * Math.sin(i * 1.7);
    const iso = d.toISOString().slice(0, 10);
    recs.push({ observed_date: iso, available_date: iso, vintage: iso, value: Number(px.toFixed(2)) });
  }
  store.upsert('lbma_pm_usd', recs);
  return recs;
}

// 造一段 COT 序列,数量可控,用于测样本不足门槛
function seedCot(store, n, start = '2025-01-01') {
  const recs = [];
  const d = new Date(start + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    d.setUTCDate(d.getUTCDate() + 7);
    const iso = d.toISOString().slice(0, 10);
    recs.push({ observed_date: iso, available_date: iso, vintage: iso, value: { net_spec: 100000 + i * 500 } });
  }
  store.upsert('cftc_gold', recs);
  return recs;
}

test('T1: sigmaDaily 为正且量级合理', () => {
  const s = B.sigmaDaily([100, 101, 100.5, 102, 101.5, 103, 102, 104]);
  assert.ok(s > 0 && s < 0.2);
});

test('T2: p0_N 按周期分别估计,长周期高于日频', () => {
  // 关键统计口径:漂移随 N 线性累积、噪声随 sqrt(N) 累积,
  // 故 20 日上涨概率必然显著高于 1 日。共用一个 p0 会让长周期基准被低估。
  const px = [];
  let v = 100;
  for (let i = 0; i < 300; i++) { v *= 1 + 0.001 + 0.01 * Math.sin(i * 2.3); px.push(v); }
  const p1 = B.p0N(px, 1);
  const p20 = B.p0N(px, 20);
  assert.ok(p20 > p1, `T+20 的无条件上涨概率应高于 T+1,实得 ${p20} vs ${p1}`);
});

test('T3: p0_N 落在 (0,1)', () => {
  const px = Array.from({ length: 300 }, (_, i) => 100 * (1 + 0.0005 * i));
  for (const n of [1, 5, 20]) {
    const p = B.p0N(px, n);
    assert.ok(p > 0 && p <= 1, `p0_${n} 越界: ${p}`);
  }
});

test('T4: 区间随 sqrt(N) 展宽', () => {
  const a = B.intervalFor(4000, 0.01, 1);
  const b = B.intervalFor(4000, 0.01, 4);
  const ratio = b.half_width / a.half_width;
  assert.ok(Math.abs(ratio - 2) < 0.05, `4 倍周期应约 2 倍宽度,实得 ${ratio}`);
});

test('T5: 区间以 1.2816 为 80% 双侧分位', () => {
  const r = B.intervalFor(4000, 0.01, 1);
  const expectedHigh = 4000 * Math.exp(1.2815515655 * 0.01);
  assert.ok(Math.abs(r.high - expectedHigh) < 0.05);
});

test('T6: baseline 只读 history,不读 facts.json', () => {
  const src = fs.readFileSync(require.resolve('../references/scripts/baseline.js'), 'utf-8');
  assert.equal(/facts\.json/.test(src), false,
    'baseline 读 facts.json 会造成 train/serve skew —— 建模必须单一数据路径');
});

test('T7: 读取一律按 availableOn 截断,不使用未来可见的修订', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  seedPrices(store, 300);
  store.upsert('fred_DFII10', [
    { observed_date: '2026-01-05', available_date: '2026-01-06', vintage: 'v1', value: 2.0 },
    { observed_date: '2026-01-05', available_date: '2026-06-01', vintage: 'v2', value: 9.9 },
  ]);
  const used = B.readFeature(store, 'fred_DFII10', '2026-02-01');
  assert.equal(used[used.length - 1].value, 2.0, '2 月 1 日不可能看到 6 月才发布的修订');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T8: 输出结构含三期与 half_width', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const recs = seedPrices(store, 400);
  const asOf = recs[recs.length - 1].observed_date;
  const out = B.computeBaseline({ store, asOf, params: null });
  for (const k of ['short', 'medium', 'long']) {
    const h = out.horizons[k];
    assert.ok(h.low < h.high, `${k} 区间非法`);
    assert.ok(h.half_width > 0);
    assert.ok(h.prob_up > 0 && h.prob_up < 1);
  }
  assert.ok(out.sigma_d > 0);
  assert.ok(out.features.p0_20 > 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T9: 无参数集时退化为 p0_N,不上 logistic', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const recs = seedPrices(store, 400);
  const out = B.computeBaseline({ store, asOf: recs[recs.length - 1].observed_date, params: null });
  assert.ok(Math.abs(out.horizons.short.prob_up - out.features.p0_1) < 1e-9,
    '未验收通过时必须退化为最简形式,不得假装聪明');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T10: 软依赖特征缺失时记入 degraded_features', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const recs = seedPrices(store, 400);
  const out = B.computeBaseline({ store, asOf: recs[recs.length - 1].observed_date, params: null });
  assert.ok(out.degraded_features.includes('cot_pctile'), '未灌 COT 数据时应显式记为缺失');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T11: COT 期数不足 20 时 cot_pctile 为 null 且记入 degraded_features', () => {
  // 与 T10 区别:灌了 COT 但期数不足,须钉住「取不到值就必须降级」不脱节
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const recs = seedPrices(store, 400);
  const asOf = recs[recs.length - 1].observed_date;
  seedCot(store, 10, '2025-01-01');
  const out = B.computeBaseline({ store, asOf, params: null });
  assert.equal(out.features.cot_pctile, null, '样本不足 20 期时分位不可信,必须为 null');
  assert.ok(out.degraded_features.includes('cot_pctile'), 'cot_pctile 为 null 时必须记入 degraded_features');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T12: 空价格历史时大声失败,报错须带序列名与 asOf', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  assert.throws(
    () => B.computeBaseline({ store, asOf: '2026-01-01', params: null }),
    /lbma_pm_usd/,
    '空历史下不得静默产出假基线,须报错并点名缺失序列',
  );
  assert.throws(
    () => B.computeBaseline({ store, asOf: '2026-01-01', params: null }),
    /2026-01-01/,
    '报错须带 asOf,值班人才能定位是哪天的数据缺失',
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T13: 单条价格历史必须大声失败,不得输出零宽区间', () => {
  // 1 条历史时 logReturns 为空,空 reduce 的初值 0 会把 NaN 吃掉、返回 0(不是 NaN),
  // 于是后续所有判空全部失效,对外宣称「80% 把握价格恰为 3000.00」
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  store.upsert('lbma_pm_usd', [
    { observed_date: '2026-01-05', available_date: '2026-01-05', vintage: 'v1', value: 3000 },
  ]);
  assert.throws(() => B.computeBaseline({ store, asOf: '2026-01-06', params: null }), /至少 3 个价格点/);
  assert.throws(() => B.sigmaDaily([3000]), /至少 3 个价格点/);
  assert.throws(() => B.sigmaDaily([3000, 3010]), /至少 3 个价格点/, '2 个点只有 1 个收益,样本标准差恒为 0');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T14: 价格连续无变化时区间会退化为零宽,须报错', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const recs = [];
  const d = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < 40; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    recs.push({ observed_date: iso, available_date: iso, vintage: iso, value: 3000 });
  }
  store.upsert('lbma_pm_usd', recs);
  assert.throws(() => B.computeBaseline({ store, asOf: recs[recs.length - 1].observed_date, params: null }),
    /零宽/, '数据停更导致的零波动不得被包装成「极高确定性」');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T15: 样本期跨到 as-of 之后的参数集必须被拒且留痕', () => {
  // --params 是绕开 asOf 的第二条数据通路。样本期结束日晚于 as-of
  // 就意味着系数拟合时见过未来,原样服务且输出上毫无痕迹是最坏的一种
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const recs = seedPrices(store, 400);
  const asOf = recs[recs.length - 1].observed_date;
  const bad = { params_id: 'p-future', sample_period: ['2000-01-01', '2099-12-31'],
    coefficients: { short: [0, 0, 0, 10], medium: [0, 0, 0, 10], long: [0, 0, 0, 10] } };
  const out = B.computeBaseline({ store, asOf, params: bad });
  assert.equal(out.params_id, null, '被拒的参数集不得留下 params_id 让下游以为用上了');
  assert.ok(out.params_rejected, '拒绝必须留痕,否则输出与「本来就没参数」无法区分');
  assert.match(out.params_rejected.reason, /未来/);
  assert.equal(out.horizons.short.model, 'p0_N');

  // 对照组:只把样本期结束日拉回 as-of,其余全同 —— 否则「一律拒绝」也能过上面的断言
  const ok = { ...bad, params_id: 'p-past', sample_period: ['2000-01-01', asOf] };
  const good = B.computeBaseline({ store, asOf, params: ok });
  assert.equal(good.params_rejected, null, '样本期结束日不晚于 as-of 的参数集应照常采纳');
  assert.equal(good.params_id, 'p-past');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T16: 特征降级时不得跑 logistic,须退回 p0 并说明原因', () => {
  // 插补 0.5 后照跑,会把「两个特征全靠插补」输出成 prob_up=0.9933 的高置信信号
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const recs = seedPrices(store, 400);
  const asOf = recs[recs.length - 1].observed_date;
  const params = { params_id: 'p-x', sample_period: ['2000-01-01', asOf],
    coefficients: { short: [0, 0, 0, 10], medium: [0, 0, 0, 10], long: [0, 0, 0, 10] } };
  const out = B.computeBaseline({ store, asOf, params });
  assert.deepEqual(out.degraded_features.sort(), ['cot_pctile', 'real_yield_chg']);
  for (const k of ['short', 'medium', 'long']) {
    assert.equal(out.horizons[k].model, 'p0_N', `${k} 特征缺失时不得跑 logistic`);
    assert.match(out.horizons[k].degraded_reason, /特征缺失/);
    assert.ok(out.horizons[k].prob_up < 0.9, `实得 ${out.horizons[k].prob_up},高置信度不能来自插补值`);
  }
  assert.equal(out.features.real_yield_chg, null, '取不到就是 null,0 会被当成「今天利率没变」');
  fs.rmSync(tmp, { recursive: true, force: true });
});
