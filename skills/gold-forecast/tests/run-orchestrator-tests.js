'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../references/scripts/run');

// ---- 夹具:形状取自 baseline.js 的真实产出(features + horizons 含 half_width) ----

function baselineFixture(overrides = {}) {
  return {
    params_id: null,
    params_rejected: null,
    base_date: '2026-07-28',
    base_price: 4022.2,
    sigma_d: 0.008,
    features: { p0_1: 0.53, p0_5: 0.57, p0_20: 0.60,
                momentum_z: 0.4, real_yield_chg: 0.02, cot_pctile: 0.7 },
    horizons: {
      short: { prob_up: 0.53, model: 'p0_N', low: 3978, high: 4067, half_width: 44.5 },
      medium: { prob_up: 0.57, model: 'p0_N', low: 3930, high: 4116, half_width: 93 },
      long: { prob_up: 0.60, model: 'p0_N', low: 3830, high: 4225, half_width: 197.5 },
    },
    degraded_features: [],
    ...overrides,
  };
}

function docFixture(horizons) {
  return { json: { horizons }, sections: {}, headings: {}, raw: '' };
}

const AI_HORIZONS = {
  short: { prob_up: 0.55, direction: 'up', low: 3987, high: 4059 },
  medium: { prob_up: 0.58, direction: 'up', low: 3940, high: 4110 },
  long: { prob_up: 0.61, direction: 'up', low: 3840, high: 4220 },
};

const FACTS = { target_date: '2026-07-28', context_tags: ['pre_cpi', 'fomc_week'], fields: {} };

// ---- 缺口 3:target_date 与 id 外推 -------------------------------------

test('T14: target_date 按工作日外推,跳过周六周日', () => {
  // 2026-07-31 是周五 ⇒ +1 应落到 08-03(周一),不能落到 08-01(周六)
  assert.equal(R.addSessions('2026-07-31', 1), '2026-08-03');
  assert.equal(R.addSessions('2026-07-28', 1), '2026-07-29');
  // 5 个交易日整好跨一个周末
  assert.equal(R.addSessions('2026-07-28', 5), '2026-08-04');
  assert.equal(R.addSessions('2026-07-28', 20), '2026-08-25');
});

test('T15: 外推结果绝不落在周末', () => {
  for (let n = 1; n <= 30; n++) {
    const d = R.addSessions('2026-07-24', n);   // 起点周五
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    assert.ok(dow !== 0 && dow !== 6, `n=${n} 外推到 ${d},落在周末`);
  }
});

test('T16: 非法 base_date 与非正 n 立即抛错,不静默产出 undefined 日期', () => {
  assert.throws(() => R.addSessions(undefined, 1), /base_date/);
  assert.throws(() => R.addSessions('2026/07/28', 1), /base_date/);
  assert.throws(() => R.addSessions('2026-07-28', 0), /正整数/);
  assert.throws(() => R.addSessions('2026-07-28', 1.5), /正整数/);
});

const HORIZON_TARGETS = (rec) => ({
  short: rec.horizons.short.target_date,
  medium: rec.horizons.medium.target_date,
  long: rec.horizons.long.target_date,
});

test('T17: id 即 short 周期的 target_date', () => {
  const rec = R.buildPredictionRecord({ doc: docFixture(AI_HORIZONS), baseline: baselineFixture(), facts: FACTS, modelId: 'MiniMax-M3' });
  assert.equal(rec.id, rec.horizons.short.target_date);
  assert.equal(rec.id, '2026-07-29');
  assert.equal(rec.base_date, '2026-07-28');
  assert.deepEqual(HORIZON_TARGETS(rec), { short: '2026-07-29', medium: '2026-08-04', long: '2026-08-25' });
});

// ---- 缺口 1:naive_p 写入端 ---------------------------------------------

test('T18: naive_p 取 features.p0_N,三期各自对应', () => {
  const rec = R.buildPredictionRecord({ doc: docFixture(AI_HORIZONS), baseline: baselineFixture(), facts: FACTS, modelId: 'm' });
  assert.equal(rec.horizons.short.naive_p, 0.53);
  assert.equal(rec.horizons.medium.naive_p, 0.57);
  assert.equal(rec.horizons.long.naive_p, 0.60);
});

test('T19: logistic 生效时 naive_p 仍等于 p0_N,不跟随 baseline.prob_up', () => {
  // 该周期通过验收后 baseline.prob_up 由 logistic 产出,不再等于 p0 —— naive 必须是无信息基准
  const bl = baselineFixture();
  bl.horizons.short = { prob_up: 0.71, model: 'logistic', low: 3978, high: 4067, half_width: 44.5 };
  const rec = R.buildPredictionRecord({ doc: docFixture(AI_HORIZONS), baseline: bl, facts: FACTS, modelId: 'm' });
  assert.equal(rec.horizons.short.baseline.prob_up, 0.71);
  assert.equal(rec.horizons.short.naive_p, 0.53, 'naive 被 logistic 输出污染,回测增益的分母就不是无信息基准');
});

test('T20: p0_N 缺失时不写 naive_p,交给 settle 的三态回退而非写入 NaN', () => {
  const bl = baselineFixture({ features: { p0_1: null, p0_5: 0.57, p0_20: 0.6 } });
  const rec = R.buildPredictionRecord({ doc: docFixture(AI_HORIZONS), baseline: bl, facts: FACTS, modelId: 'm' });
  assert.equal('naive_p' in rec.horizons.short, false);
  assert.equal(rec.horizons.medium.naive_p, 0.57);
});

// ---- 缺口 2:c9_triggered 独立复算 --------------------------------------

test('T21: 概率偏离超 0.08 即 c9_triggered=true', () => {
  const bl = baselineFixture();
  const ai = { ...AI_HORIZONS, short: { prob_up: 0.53 + 0.09, low: 3978, high: 4067 } };
  const rec = R.buildPredictionRecord({ doc: docFixture(ai), baseline: bl, facts: FACTS, modelId: 'm' });
  assert.equal(rec.c9_triggered, true);
});

test('T22: 区间中心偏移超 0.5×half_width 即触发,与概率各自独立', () => {
  const bl = baselineFixture();
  // 概率不动,只把 short 区间整体上移 30(>0.5×44.5=22.25)
  const ai = { ...AI_HORIZONS, short: { prob_up: 0.53, low: 4008, high: 4097 } };
  const rec = R.buildPredictionRecord({ doc: docFixture(ai), baseline: bl, facts: FACTS, modelId: 'm' });
  assert.equal(rec.c9_triggered, true);
});

test('T23: 三期都贴着基线时为 false,且必须是严格布尔', () => {
  const bl = baselineFixture();
  const ai = {
    short: { prob_up: 0.54, low: 3980, high: 4069 },
    medium: { prob_up: 0.58, low: 3932, high: 4118 },
    long: { prob_up: 0.61, low: 3832, high: 4227 },
  };
  const rec = R.buildPredictionRecord({ doc: docFixture(ai), baseline: bl, facts: FACTS, modelId: 'm' });
  // 读取端是 `=== true`,写 0 / "" / null 都会让 scorecard 的 c9_high_rate 永久静默
  assert.equal(rec.c9_triggered, false);
  assert.equal(typeof rec.c9_triggered, 'boolean');
});

test('T24: 降级记录 final 即 baseline,c9_triggered 恒 false 而非 undefined', () => {
  const rec = R.buildPredictionRecord({ doc: null, baseline: baselineFixture(), facts: FACTS, modelId: null, degraded: true });
  assert.equal(rec.c9_triggered, false);
  assert.equal(typeof rec.c9_triggered, 'boolean');
  assert.deepEqual(rec.horizons.short.final, rec.horizons.short.baseline);
});

test('T25: computeC9Triggered 只看给到的两侧,缺周期跳过不误判', () => {
  assert.equal(R.computeC9Triggered({}, {}), false);
  assert.equal(R.computeC9Triggered({ short: { prob_up: 0.9 } }, {}), false);
  assert.equal(R.computeC9Triggered(
    { short: { prob_up: 0.9 } }, { short: { prob_up: 0.5, half_width: 10 } }), true);
});

// ---- 缺口 4:进 prompt 的 scorecard 剥掉 data_quality --------------------

test('T26: scorecardForPrompt 剥掉 data_quality,其余原样保留', () => {
  const sc = { by_horizon: { short: { n: 25 } }, coverage: { expected: 3 },
               data_quality: [{ horizon: 'short', group: 'naive', field: 'brier', dropped: 3 }],
               review_triggers: [] };
  const out = R.scorecardForPrompt(sc);
  assert.equal('data_quality' in out, false, '模型看得见却不在 C4 允许池里,一引用就三轮全废');
  assert.deepEqual(out.by_horizon, sc.by_horizon);
  assert.deepEqual(out.coverage, sc.coverage);
  assert.deepEqual(out.review_triggers, []);
  assert.ok('data_quality' in sc, '不得就地改动调用方对象');
});

test('T27: scorecardForPrompt 对 null / 非对象原样返回,不崩', () => {
  assert.equal(R.scorecardForPrompt(null), null);
  assert.equal(R.scorecardForPrompt(undefined), undefined);
  assert.deepEqual(R.scorecardForPrompt([1, 2]), [1, 2]);
});

// ---- 记录整体形状 -------------------------------------------------------

test('T28: 记录含设计 5.2 的全部字段,且不含孤儿字段 cited_lessons', () => {
  const rec = R.buildPredictionRecord({ doc: docFixture(AI_HORIZONS), baseline: baselineFixture(), facts: FACTS, modelId: 'MiniMax-M3' });
  for (const k of ['id', 'base_date', 'base_price', 'base_source', 'facts_checksum',
                   'model_id', 'degraded', 'horizons', 'context_tags', 'c9_triggered']) {
    assert.ok(k in rec, `缺字段 ${k}`);
  }
  assert.equal('cited_lessons' in rec, false, '孤儿字段无生产者无消费者,不实现');
  assert.equal(rec.model_id, 'MiniMax-M3');
  assert.deepEqual(rec.context_tags, ['pre_cpi', 'fomc_week']);
  assert.match(rec.facts_checksum, /^sha256:[0-9a-f]{64}$/);
  assert.equal(rec.horizons.short.n_sessions, 1);
  assert.equal(rec.horizons.medium.n_sessions, 5);
  assert.equal(rec.horizons.long.n_sessions, 20);
  assert.equal(rec.horizons.long.settled, false);
});

test('T29: final 取 AI、baseline 取 baseline.json,两者不得互相覆盖', () => {
  const rec = R.buildPredictionRecord({ doc: docFixture(AI_HORIZONS), baseline: baselineFixture(), facts: FACTS, modelId: 'm' });
  assert.deepEqual(rec.horizons.short.final, { prob_up: 0.55, low: 3987, high: 4059 });
  assert.deepEqual(rec.horizons.short.baseline, { prob_up: 0.53, low: 3978, high: 4067 });
  // model / half_width 属基线内部字段,不进记录
  assert.equal('half_width' in rec.horizons.short.baseline, false);
  assert.equal('direction' in rec.horizons.short.final, false);
});

test('T30: 特征降级或编排层降级,任一成立即 degraded=true', () => {
  const a = R.buildPredictionRecord({ doc: docFixture(AI_HORIZONS), baseline: baselineFixture({ degraded_features: ['cot_pctile'] }), facts: FACTS, modelId: 'm' });
  assert.equal(a.degraded, true);
  const b = R.buildPredictionRecord({ doc: docFixture(AI_HORIZONS), baseline: baselineFixture(), facts: FACTS, modelId: 'm', degraded: true });
  assert.equal(b.degraded, true);
  const c = R.buildPredictionRecord({ doc: docFixture(AI_HORIZONS), baseline: baselineFixture(), facts: FACTS, modelId: 'm' });
  assert.equal(c.degraded, false);
});

test('T31: facts_checksum 随 facts 变化,同输入可复现', () => {
  const mk = (facts) => R.buildPredictionRecord({ doc: docFixture(AI_HORIZONS), baseline: baselineFixture(), facts, modelId: 'm' }).facts_checksum;
  assert.equal(mk(FACTS), mk({ ...FACTS }));
  assert.notEqual(mk(FACTS), mk({ ...FACTS, target_date: '2026-07-27' }));
});

test('T32: baseline 缺 horizons 或缺周期立即抛错,不产出半截记录', () => {
  assert.throws(() => R.buildPredictionRecord({ doc: null, baseline: { base_date: '2026-07-28' }, facts: FACTS }), /baseline\.horizons/);
  const bl = baselineFixture();
  delete bl.horizons.long;
  assert.throws(() => R.buildPredictionRecord({ doc: null, baseline: bl, facts: FACTS }), /horizons\.long/);
});
