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
