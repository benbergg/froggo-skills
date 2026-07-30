'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../references/scripts/run');

const okStdout = (over = {}) => JSON.stringify({
  ok: true, provider: 'minimax', model: 'MiniMax-M3', attempts: [],
  outputs: [{ text: 'hello', mediaUrl: null }], ...over,
});

// ---- 模型调用契约(设计 3.6) ------------------------------------------

test('T1: pin 校验 —— 返回模型不符即判失败', () => {
  const r = R.interpretModelResult({ status: 0, stdout: JSON.stringify({ ok: true, model: 'glm-5.1', attempts: [], outputs: [{ text: 'x' }] }) }, 'MiniMax-M3');
  assert.equal(r.kind, 'pin_mismatch', '静默换模型会污染 final 曲线');
});

test('T2: attempts 非空说明发生过 failover,同样判失败', () => {
  const r = R.interpretModelResult({ status: 0, stdout: JSON.stringify({ ok: true, model: 'MiniMax-M3', attempts: [{ provider: 'x' }], outputs: [{ text: 'y' }] }) }, 'MiniMax-M3');
  assert.equal(r.kind, 'pin_mismatch');
});

test('T3: 正常返回被接受', () => {
  const r = R.interpretModelResult({ status: 0, stdout: JSON.stringify({ ok: true, model: 'MiniMax-M3', attempts: [], outputs: [{ text: 'hello' }] }) }, 'MiniMax-M3');
  assert.equal(r.kind, 'ok');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'hello');
});

test('T4: 参数超长的失败签名被单独识别', () => {
  // exit=null + stdout 空 + 极快返回,长得像模型故障,实为 E2BIG。
  const r = R.interpretModelResult({ status: null, stdout: '', stderr: '' }, 'MiniMax-M3');
  assert.equal(r.kind, 'oversize', '误判成 infra 会白白重试三轮,每轮还要付 13 秒冷启动');
});

test('T5: 其他非零退出判为基础设施失败', () => {
  const r = R.interpretModelResult({ status: 1, stdout: '', stderr: 'boom' }, 'MiniMax-M3');
  assert.equal(r.kind, 'infra');
});

test('T6: 非交易日为首个分支且不记入 skipped_dates', () => {
  const o = R.classifyOutcome({ isTradingDay: false });
  assert.equal(o.outcome, 'non_trading_day');
  assert.equal(o.recordSkipped, false, '周末不是故障,记入会污染覆盖率');
  assert.equal(o.push, false);
});

test('T7: 结算前失败与结算后失败区分', () => {
  const a = R.classifyOutcome({ isTradingDay: true, settled: false, failedStep: 'collect-settlement' });
  assert.equal(a.outcome, 'failed_before_settle');
  const b = R.classifyOutcome({ isTradingDay: true, settled: true, failedStep: 'validate' });
  assert.equal(b.outcome, 'failed_after_settle');
  assert.equal(b.recordSkipped, true);
});

test('T8: 降级成功仍推正常报告', () => {
  const o = R.classifyOutcome({ isTradingDay: true, settled: true, degraded: true, failedStep: null });
  assert.equal(o.outcome, 'degraded_success');
  assert.equal(o.push, true);
});

test('T9: 全通过为 success', () => {
  const o = R.classifyOutcome({ isTradingDay: true, settled: true, degraded: false, failedStep: null });
  assert.equal(o.outcome, 'success');
});

test('T10: 目标日由最新定盘日推导,不用系统时钟', () => {
  const d = R.resolveToday({ latestSession: '2026-07-28' });
  assert.equal(d, '2026-07-28', '时钟漂移不应导致写错日期的预测');
  // 缺失时必须抛错:静默返回 undefined 会产出 id 为 "undefined" 的记录
  assert.throws(() => R.resolveToday({}), /latestSession/);
  assert.throws(() => R.resolveToday({ latestSession: '28/07/2026' }), /latestSession/);
});

test('T11: 修复循环上限 3 轮', () => {
  assert.equal(R.MAX_FIX_ROUNDS, 3);
});

test('T12: 删产物只在最终放弃时', () => {
  assert.equal(R.shouldDeleteArtifacts({ round: 1, passed: false }), false, '第 2 轮要拿它来改');
  assert.equal(R.shouldDeleteArtifacts({ round: 3, passed: false }), true);
  assert.equal(R.shouldDeleteArtifacts({ round: 3, passed: true }), false);
});

test('T13: 模型阶段超时预算 120s,采集 300s', () => {
  assert.equal(R.BUDGET.model_ms, 120_000);
  assert.equal(R.BUDGET.collect_ms, 300_000);
});

// ---- P15-1:oversize 判据不能与 spawnSync 超时撞车 ----------------------

test('T33: 超时被 kill 判 infra,不判 oversize', () => {
  // 现场实测:超时 kill 与 E2BIG 在 status/stdout 上完全一致,差别只在 signal/error。
  // 判成 oversize 就等于既不重试也不算 infra,真故障被静默吞掉。
  const r = R.interpretModelResult(
    { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }, 'MiniMax-M3');
  assert.equal(r.kind, 'infra', '网关变慢被误判成 prompt 太大,永远不会重试');
});

test('T34: signal 与 error 只有其一时同样判 infra', () => {
  assert.equal(R.interpretModelResult({ status: null, signal: 'SIGKILL', stdout: '' }, 'M').kind, 'infra');
  assert.equal(R.interpretModelResult({ status: null, stdout: '', error: { code: 'ETIMEDOUT' } }, 'M').kind, 'infra');
});

test('T35: error.code=E2BIG 直接判 oversize,优先级高于其他分支', () => {
  const r = R.interpretModelResult({ status: null, signal: null, stdout: '', error: { code: 'E2BIG' } }, 'MiniMax-M3');
  assert.equal(r.kind, 'oversize');
});

// ---- P5:pin 比对两侧归一化 --------------------------------------------

test('T36: 完整 slug 与裸名互认,两种写法都不误判 pin_mismatch', () => {
  const bare = R.interpretModelResult({ status: 0, stdout: okStdout({ model: 'MiniMax-M3' }) }, 'minimax/MiniMax-M3');
  assert.equal(bare.kind, 'ok', 'openclaw 回裸名而 pin 写全 slug,恒判失败会天天降级');
  const slug = R.interpretModelResult({ status: 0, stdout: okStdout({ model: 'minimax/MiniMax-M3' }) }, 'MiniMax-M3');
  assert.equal(slug.kind, 'ok');
  const cased = R.interpretModelResult({ status: 0, stdout: okStdout({ model: 'minimax/minimax-m3' }) }, 'minimax/MiniMax-M3');
  assert.equal(cased.kind, 'ok');
});

test('T37: 归一化不得放过真正的换模型', () => {
  // 归一化只吃掉 provider 前缀与大小写,模型名本体不同必须仍判失败
  for (const other of ['glm-5.1', 'minimax/MiniMax-M2', 'anthropic/MiniMax-M3-lite']) {
    const r = R.interpretModelResult({ status: 0, stdout: okStdout({ model: other }) }, 'minimax/MiniMax-M3');
    assert.equal(r.kind, 'pin_mismatch', `${other} 应判 pin_mismatch`);
  }
});

// ---- P15-2:第六种结局 -------------------------------------------------

test('T38: 模型/参数故障单独产出 infra_failure,并带具体签名', () => {
  for (const kind of ['oversize', 'infra']) {
    const o = R.classifyOutcome({ isTradingDay: true, settled: true, failedStep: 'model', failureKind: kind });
    assert.equal(o.outcome, 'infra_failure', `${kind} 应归 infra_failure,而非折进 failed_after_settle`);
    assert.equal(o.signature, kind, '失败简报要能指向真正的原因');
    assert.equal(o.recordSkipped, true);
    assert.equal(o.push, true);
  }
});

test('T39: pin_mismatch 不是 infra_failure —— 它走降级发基线的路', () => {
  // 设计 3.7:pin 校验失败 → degraded_success(照发基线预测、照结算,统计不断档)
  const o = R.classifyOutcome({ isTradingDay: true, settled: true, degraded: true, failedStep: null, failureKind: 'pin_mismatch' });
  assert.equal(o.outcome, 'degraded_success');
  assert.equal(o.push, true);
  assert.equal(o.recordSkipped, false);
  // 上面那条走的是 failedStep=null 分支,压根到不了 INFRA_KINDS,对"pin_mismatch 是否
  // 被误列入 infra 集合"零判别力(把它加进集合照样绿)。故必须再钉一次集合成员:
  // 万一日后有人给 pin_mismatch 配上 failedStep,结局不能悄悄从降级变成 infra_failure。
  const withStep = R.classifyOutcome({ isTradingDay: true, settled: true, failedStep: 'model', failureKind: 'pin_mismatch' });
  assert.equal(withStep.outcome, 'failed_after_settle', 'pin_mismatch 不属于 infra 签名集合');
});

test('T40: 六种结局齐全,且退出码把成功/失败分开', () => {
  const seen = new Set([
    R.classifyOutcome({ isTradingDay: false }).outcome,
    R.classifyOutcome({ isTradingDay: true, settled: true, failedStep: null, degraded: false }).outcome,
    R.classifyOutcome({ isTradingDay: true, settled: true, failedStep: null, degraded: true }).outcome,
    R.classifyOutcome({ isTradingDay: true, settled: false, failedStep: 'x' }).outcome,
    R.classifyOutcome({ isTradingDay: true, settled: true, failedStep: 'x' }).outcome,
    R.classifyOutcome({ isTradingDay: true, settled: true, failedStep: 'x', failureKind: 'oversize' }).outcome,
  ]);
  assert.equal(seen.size, 6, `应产出六种结局,实得 ${[...seen].join(',')}`);
  for (const o of seen) assert.ok(o in R.EXIT_BY_OUTCOME, `${o} 缺退出码映射`);
  assert.equal(R.EXIT_BY_OUTCOME.non_trading_day, 0);
  assert.equal(R.EXIT_BY_OUTCOME.degraded_success, 0);
  assert.ok(R.EXIT_BY_OUTCOME.failed_after_settle !== 0);
  assert.notEqual(R.EXIT_BY_OUTCOME.infra_failure, R.EXIT_BY_OUTCOME.failed_after_settle,
    'infra_failure 与普通失败退同一码就等于没有第六种');
});

// ---- callModel 的注入点(绝不真调计费模型) -----------------------------

test('T41: callModel 不经 shell、pin 到 M3、超时用 BUDGET.model_ms', () => {
  const calls = [];
  const spawnImpl = (bin, argv, opts) => { calls.push({ bin, argv, opts }); return { status: 0, stdout: okStdout() }; };
  const r = R.callModel('prompt 含 $(whoami) 与 `反引号`', { bin: '/fake/openclaw', spawnImpl });
  assert.equal(r.kind, 'ok');
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.bin, '/fake/openclaw');
  assert.deepEqual(c.argv.slice(0, 6), ['infer', 'model', 'run', '--model', R.PINNED_MODEL, '--json']);
  assert.equal(c.argv[6], '--prompt');
  assert.equal(c.argv[7], 'prompt 含 $(whoami) 与 `反引号`', 'prompt 须原样直传,不做任何转义');
  assert.equal(c.opts.timeout, R.BUDGET.model_ms);
  assert.equal(c.opts.shell, undefined, '经 shell 会把新闻标题里的 $ 与反引号变成注入面');
  assert.equal(c.opts.maxBuffer, 64 << 20);
});

test('T42: PINNED_MODEL 就是 minimax/MiniMax-M3', () => {
  assert.equal(R.PINNED_MODEL, 'minimax/MiniMax-M3');
});

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

// ======================================================================
// 编排层:全部经注入点驱动 —— 不起任何真子进程、不调计费模型、不碰外部网络
// ======================================================================

const GOOD_FORECAST = ['```json',
  JSON.stringify({ horizons: AI_HORIZONS }, null, 1),
  '```', '',
  '## 一、今日结论', '看涨', '',
  '## 七、免责声明', '固定文案'].join('\n');

const argOf = (args, flag) => args[args.indexOf(flag) + 1];

// 桩:每个步骤只做「本该产出的文件」,退出码由 fail 表指定。
function harness({ fail = {}, findingsSeq = null, modelSeq = null, ...opts } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-run-'));
  const stateDir = path.join(tmp, 'state');
  const archiveDir = path.join(tmp, 'archive');
  fs.mkdirSync(stateDir, { recursive: true });
  const S = (n) => path.join(stateDir, n);
  const calls = [];
  const logs = [];
  const write = (p, v) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof v === 'string' ? v : `${JSON.stringify(v, null, 1)}\n`);
  };
  const findings = findingsSeq ? [...findingsSeq] : null;
  const models = modelSeq ? [...modelSeq] : null;

  const runScriptImpl = (name, args, o) => {
    calls.push({ name, args, opts: o });
    const code = Object.prototype.hasOwnProperty.call(fail, name) ? fail[name] : 0;
    if (code === 0 || name === 'commit') {
      if (name === 'collect-settlement') {
        write(S('settlement-price.json'), { series: 'lbma_pm_usd', latest: { date: '2026-07-28', value: 4022.2 },
          history: [{ date: '2026-07-27', value: 4010 }, { date: '2026-07-28', value: 4022.2 }], freshness_ok: true });
      }
      if (name === 'scorecard') write(argOf(args, '--out'), { by_horizon: {}, coverage: {}, data_quality: [], review_triggers: [] });
      if (name === 'collect-facts') write(argOf(args, '--out'), FACTS);
      if (name === 'baseline') write(argOf(args, '--out'), baselineFixture());
      if (name === 'validate') write(argOf(args, '--out'), (findings && findings.shift()) || { passed: true, findings: [] });
      if (name === 'render') { write(argOf(args, '--out-html'), '<html></html>'); write(argOf(args, '--out-md'), '# md'); }
    }
    return { code, stdout: '', stderr: `${name} stub`, timedOut: false };
  };
  const callModelImpl = () => (models && models.length ? models.shift()
    : { ok: true, kind: 'ok', model: 'MiniMax-M3', attempts: [], text: GOOD_FORECAST });

  const res = R.runPipeline({ stateDir, archiveDir, runScriptImpl, callModelImpl,
                              log: (m) => logs.push(m), ...opts });
  const order = calls.map((c) => c.name);
  return { res, calls, order, logs, tmp, stateDir, archiveDir, S,
           work: R.workPaths(path.join(stateDir, 'work')),
           readState: () => JSON.parse(fs.readFileSync(S('predictions.json'), 'utf-8')),
           cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('T43: 全通过时步骤顺序即设计 3.5 的 1a→2→2b→1b→3→4/5→render→commit→push', () => {
  const h = harness();
  assert.deepEqual(h.order, ['collect-settlement', 'settle', 'scorecard', 'collect-facts',
                             'baseline', 'validate', 'render', 'commit', 'push']);
  assert.equal(h.res.outcome, 'success');
  assert.equal(h.res.exitCode, 0);
  assert.equal(h.res.degraded, false);
  // 校验必须先于入库,入库必须先于推送 —— 顺序本身就是正确性约束
  assert.ok(h.order.indexOf('validate') < h.order.indexOf('commit'));
  assert.ok(h.order.indexOf('settle') < h.order.indexOf('commit'));
  h.cleanup();
});

test('T44: Step 1b 失败时 1a→2→2b 仍完成,结局为 failed_after_settle', () => {
  const h = harness({ fail: { 'collect-facts': 3 } });
  assert.deepEqual(h.order.slice(0, 4), ['collect-settlement', 'settle', 'scorecard', 'collect-facts']);
  assert.equal(h.order.includes('commit'), false, '未通过自检的东西绝不入库');
  assert.equal(h.res.outcome, 'failed_after_settle', '结算已完成,简报必须这么说');
  assert.equal(h.res.exitCode, 6);
  // 结算产物仍在:东财故障那天不该连结算也停
  assert.ok(fs.existsSync(h.S('settlement-price.json')));
  assert.ok(fs.existsSync(h.S('scorecard.json')));
  assert.ok(h.order.includes('push'), '失败也要推简报');
  h.cleanup();
});

test('T45: Step 1a 失败即 failed_before_settle,后续一步都不跑', () => {
  const h = harness({ fail: { 'collect-settlement': 4 } });
  assert.deepEqual(h.order, ['collect-settlement', 'push']);
  assert.equal(h.res.outcome, 'failed_before_settle');
  // 连目标日都不知道,宁可不记 skipped_dates 也不编一个日期
  assert.ok(h.logs.some((m) => /不记 skipped_dates/.test(m)));
  h.cleanup();
});

test('T46: 采集两步真的用上 BUDGET.collect_ms(不是只声明常量)', () => {
  const h = harness();
  for (const name of ['collect-settlement', 'collect-facts']) {
    const c = h.calls.find((x) => x.name === name);
    assert.equal(c.opts.timeoutMs, R.BUDGET.collect_ms, `${name} 未使用采集超时预算`);
  }
  h.cleanup();
});

test('T47: runScript 把超时传进 spawn,并把超时 kill 归一成非零退出码', () => {
  const seen = [];
  const ok = R.runScript('settle', ['--x'], { timeoutMs: 1234, spawnImpl: (bin, argv, o) => { seen.push({ bin, argv, o }); return { status: 0, stdout: '', stderr: '' }; } });
  assert.equal(seen[0].o.timeout, 1234);
  assert.equal(seen[0].argv[0].endsWith('settle.js'), true);
  assert.equal(ok.code, 0);
  // status=null(被 kill)若原样传出去,`code !== 0` 判不出来,失败会被当成成功
  const killed = R.runScript('settle', [], { spawnImpl: () => ({ status: null, error: { code: 'ETIMEDOUT' } }) });
  assert.notEqual(killed.code, 0);
  assert.equal(killed.timedOut, true);
  assert.throws(() => R.runScript('不存在的步骤', [], {}), /未知步骤/);
});

test('T48: 无新定盘即 non_trading_day,不推送、不记 skipped_dates', () => {
  const h0 = harness();          // 先跑一次,让库里留下 base_date=2026-07-28
  h0.cleanup();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-run-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'predictions.json'), JSON.stringify({
    schema_version: 2, skipped_dates: [],
    predictions: [{ id: '2026-07-29', base_date: '2026-07-28', horizons: {} }],
  }));
  const calls = [];
  const res = R.runPipeline({
    stateDir, archiveDir: path.join(tmp, 'archive'), log: () => {},
    callModelImpl: () => { throw new Error('非交易日绝不该调模型'); },
    runScriptImpl: (name, args) => {
      calls.push(name);
      if (name === 'collect-settlement') {
        fs.writeFileSync(path.join(stateDir, 'settlement-price.json'), JSON.stringify({
          latest: { date: '2026-07-28', value: 4022.2 }, history: [] }));
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(res.outcome, 'non_trading_day');
  assert.equal(res.push, false);
  assert.equal(res.recordSkipped, false, '周末不是故障,记入会污染覆盖率');
  assert.deepEqual(calls, ['collect-settlement'], '闸门要在结算之前就拦住');
  const db = JSON.parse(fs.readFileSync(path.join(stateDir, 'predictions.json'), 'utf-8'));
  assert.deepEqual(db.skipped_dates, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T49: hasNewSession 首次运行照跑,不比已有 base_date 新就跳过', () => {
  assert.equal(R.hasNewSession({ latestSession: '2026-07-28', db: null }), true);
  assert.equal(R.hasNewSession({ latestSession: '2026-07-28', db: { predictions: [] } }), true);
  const db = { predictions: [{ base_date: '2026-07-24' }, { base_date: '2026-07-28' }] };
  assert.equal(R.hasNewSession({ latestSession: '2026-07-28', db }), false);
  assert.equal(R.hasNewSession({ latestSession: '2026-07-27', db }), false, '陈旧价格同样要被拦住');
  assert.equal(R.hasNewSession({ latestSession: '2026-07-29', db }), true);
});

test('T50: 显式 --today 表示人工补跑,跳过无新定盘闸门', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-run-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'predictions.json'), JSON.stringify({
    schema_version: 2, skipped_dates: [],
    predictions: [{ id: '2026-07-29', base_date: '2026-07-28', horizons: {} }] }));
  const h = harnessOn(tmp, stateDir, { today: '2026-07-28' });
  assert.notEqual(h.res.outcome, 'non_trading_day');
  assert.ok(h.order.includes('commit'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 复用 harness 的桩,但指定已存在的 stateDir
function harnessOn(tmp, stateDir, opts) {
  const S = (n) => path.join(stateDir, n);
  const calls = [];
  const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof v === 'string' ? v : `${JSON.stringify(v, null, 1)}\n`); };
  const runScriptImpl = (name, args, o) => {
    calls.push({ name, args, opts: o });
    if (name === 'collect-settlement') {
      write(S('settlement-price.json'), { latest: { date: '2026-07-28', value: 4022.2 },
        history: [{ date: '2026-07-28', value: 4022.2 }] });
    }
    if (name === 'scorecard') write(argOf(args, '--out'), { by_horizon: {}, data_quality: [] });
    if (name === 'collect-facts') write(argOf(args, '--out'), FACTS);
    if (name === 'baseline') write(argOf(args, '--out'), baselineFixture());
    if (name === 'validate') write(argOf(args, '--out'), { passed: true, findings: [] });
    if (name === 'render') { write(argOf(args, '--out-html'), '<html>'); write(argOf(args, '--out-md'), '# md'); }
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = R.runPipeline({ stateDir, archiveDir: path.join(tmp, 'archive'), log: () => {},
    runScriptImpl, callModelImpl: () => ({ ok: true, kind: 'ok', model: 'MiniMax-M3', attempts: [], text: GOOD_FORECAST }),
    ...opts });
  return { res, calls, order: calls.map((c) => c.name) };
}

test('T51: 第一轮自检不过时不删产物,findings 与原文回灌后第二轮通过', () => {
  const bad = { passed: false, findings: [{ check: 'C4', locator: '第二段:「4100」', expected: 'x', actual: '4100' }] };
  const h = harness({ findingsSeq: [bad, { passed: true, findings: [] }] });
  assert.equal(h.res.outcome, 'success');
  assert.equal(h.res.rounds, 2);
  // 只重跑 Step 4→5:采集与结算各自只跑一次,否则白烧三倍采集配额
  assert.equal(h.order.filter((n) => n === 'validate').length, 2);
  assert.equal(h.order.filter((n) => n === 'collect-facts').length, 1);
  assert.equal(h.order.filter((n) => n === 'settle').length, 1);
  // 第 1 轮的产物必须还在 —— 校验器删产物会让第 2 轮无从改起
  assert.ok(fs.existsSync(h.work.forecast(1)), '第 2 轮要拿它来改');
  assert.ok(fs.existsSync(h.work.findings(1)));
  // 第 2 轮的 prompt 里应能看到上一轮的 findings
  const p2 = fs.readFileSync(h.work.prompt(2), 'utf-8');
  assert.ok(p2.includes('第二段:「4100」'), 'findings 没喂回去,第 2 轮只是原地重掷骰子');
  assert.ok(p2.includes('上一轮'), '上一轮原文须一并喂回');
  h.cleanup();
});

test('T52: 三轮都不过 → 删产物、标 degraded、仍入库并推正常报告', () => {
  const bad = { passed: false, findings: [{ check: 'C1', locator: 'JSON块', expected: 'x', actual: 'y' }] };
  const h = harness({ findingsSeq: [bad, bad, bad] });
  assert.equal(h.res.rounds, 3);
  assert.equal(h.res.outcome, 'degraded_success');
  assert.equal(h.res.exitCode, 0);
  assert.equal(h.res.degraded, true);
  for (let r = 1; r <= 3; r++) {
    assert.equal(fs.existsSync(h.work.forecast(r)), false, `第 ${r} 轮产物应在最终放弃时删除`);
    assert.equal(fs.existsSync(h.work.findings(r)), false);
  }
  // 退化为只发基线预测:报告与记录照出,照入库照推送
  assert.ok(fs.existsSync(h.work.degradedForecast));
  assert.ok(h.order.includes('commit'));
  assert.ok(h.order.includes('push'));
  const rec = JSON.parse(fs.readFileSync(h.work.record, 'utf-8'));
  assert.equal(rec.degraded, true);
  assert.deepEqual(rec.horizons.short.final, rec.horizons.short.baseline);
  h.cleanup();
});

test('T53: pin 校验失败即降级,不重试模型、不进修复循环', () => {
  const h2 = harness({ modelSeq: [{ ok: false, kind: 'pin_mismatch', model: 'glm-5.1', attempts: [] }] });
  assert.equal(h2.res.outcome, 'degraded_success');
  assert.equal(h2.res.rounds, 1, 'pin 不符重试也是同一个结果');
  assert.equal(h2.order.includes('validate'), false, '没有模型输出可校验');
  assert.ok(h2.order.includes('commit'), '基线预测照发照结算,统计不断档');
  const rec = JSON.parse(fs.readFileSync(h2.work.record, 'utf-8'));
  assert.equal(rec.degraded, true);
  assert.equal(rec.model_id, null, '不能把 pin 不符的那个模型记成本期模型');
  // 中途 break 出循环时不能落进「最终放弃」的删除分支:prompt-r1 是唯一能证明
  // 当时发了什么的诊断件,而降级原因必须仍指向 pin 而不是被改写成「3 轮未通过」。
  assert.ok(fs.existsSync(h2.work.prompt(1)), 'pin 不符不是自检失败,不该删诊断件');
  assert.ok(h2.logs.some((m) => /降级.*pin/.test(m)), `降级原因被改写:${h2.logs.join(' | ')}`);
  assert.equal(h2.logs.some((m) => /降级.*3 轮/.test(m)), false, '把 pin 不符说成自检 3 轮未通过会把排查引向无关方向');
  h2.cleanup();
});

test('T54: infra 类失败重试到上限后判 infra_failure,不入库', () => {
  const infra = { ok: false, kind: 'infra', stderr: 'gateway 502' };
  const h = harness({ modelSeq: [infra, infra, infra] });
  assert.equal(h.res.outcome, 'infra_failure');
  assert.equal(h.res.failureKind, 'infra');
  assert.equal(h.res.exitCode, 7);
  assert.equal(h.order.includes('commit'), false);
  assert.ok(h.order.includes('push'), '失败简报要发');
  h.cleanup();
});

test('T55: 参数超长不重试,直接 infra_failure', () => {
  let calls = 0;
  const h = harness({ modelSeq: [{ ok: false, kind: 'oversize' }] });
  assert.equal(h.res.outcome, 'infra_failure');
  assert.equal(h.res.failureKind, 'oversize');
  h.cleanup();
  // 重试次数由 callModelWithRetry 管:oversize 一次即返回,infra 才试满
  const r1 = R.callModelWithRetry('p', { callModelImpl: () => { calls++; return { ok: false, kind: 'oversize' }; } });
  assert.equal(calls, 1, '误判成 infra 会白白重试三轮,每轮还要付 13 秒冷启动');
  assert.equal(r1.tries, 1);
  calls = 0;
  const r2 = R.callModelWithRetry('p', { callModelImpl: () => { calls++; return { ok: false, kind: 'infra' }; } });
  assert.equal(calls, R.MODEL_MAX_ATTEMPTS);
  assert.equal(r2.tries, R.MODEL_MAX_ATTEMPTS);
  calls = 0;
  R.callModelWithRetry('p', { callModelImpl: () => { calls++; return { ok: false, kind: 'pin_mismatch' }; } });
  assert.equal(calls, 1, 'pin 不符重试也是同一个结果');
});

test('T56: commit 退 3(备份失败)算成功:照推报告,但退出码透传 3', () => {
  const h = harness({ fail: { commit: 3 } });
  assert.equal(h.res.outcome, 'success', '为一个 rsync 问题重跑整条流水线要再付一次模型费用');
  assert.equal(h.res.backupFailed, true);
  assert.equal(h.res.exitCode, 3, 'cron 日志里仍要刺眼');
  assert.ok(h.order.includes('push'));
  assert.ok(h.logs.some((m) => /恢复源|备份/.test(m)));
  h.cleanup();
});

test('T57: commit 退 5(运行期异常/权威库损坏)是失败,不当参数错重试', () => {
  const h = harness({ fail: { commit: 5 } });
  assert.equal(h.res.outcome, 'failed_after_settle');
  assert.equal(h.res.exitCode, 6);
  assert.equal(h.order.filter((n) => n === 'commit').length, 1, '5 不是参数错,重试没有意义');
  assert.equal(h.order.includes('push') && h.res.failedStep === 'commit', true);
  h.cleanup();
});

test('T58: push 失败不推翻已入库的事实,退出码 4 且不再补发简报', () => {
  const h = harness({ fail: { push: 4 } });
  assert.equal(h.res.outcome, 'success');
  assert.equal(h.res.pushFailed, true);
  assert.equal(h.res.exitCode, 4);
  assert.equal(h.order.filter((n) => n === 'push').length, 1, '同一条通道刚失败,简报会以完全相同的方式失败');
  h.cleanup();
});

test('T59: dry-run 跳过入库与推送,采集/结算/渲染照常', () => {
  const h = harness({ dryRun: true });
  assert.deepEqual(h.order, ['collect-settlement', 'settle', 'scorecard', 'collect-facts',
                             'baseline', 'validate', 'render']);
  assert.equal(h.order.includes('commit'), false);
  assert.equal(h.order.includes('push'), false);
  assert.equal(h.res.outcome, 'success');
  // dry-run 的验收标准就是「各步产物齐备」
  assert.ok(fs.existsSync(h.work.reportHtml));
  assert.ok(fs.existsSync(h.work.record));
  h.cleanup();
});

test('T60: dry-run 失败时也不发飞书', () => {
  const h = harness({ dryRun: true, fail: { baseline: 1 } });
  assert.equal(h.order.includes('push'), false);
  assert.equal(h.res.outcome, 'failed_after_settle');
  h.cleanup();
});

test('T61: 连续失败天数累计,成功与非交易日都清零', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-state-'));
  const p = path.join(tmp, 'run-state.json');
  assert.equal(R.bumpRunState(p, 'failed_after_settle').consecutive_failures, 1);
  assert.equal(R.bumpRunState(p, 'infra_failure').consecutive_failures, 2);
  assert.equal(R.bumpRunState(p, 'failed_before_settle').consecutive_failures, 3);
  assert.equal(R.bumpRunState(p, 'non_trading_day').consecutive_failures, 0, '周末不是失败');
  R.bumpRunState(p, 'failed_after_settle');
  assert.equal(R.bumpRunState(p, 'degraded_success').consecutive_failures, 0, '降级发出去了就不算失败');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T62: 失败简报带上连续失败天数', () => {
  const h1 = harness({ fail: { baseline: 1 } });
  const brief = h1.calls.find((c) => c.name === 'push');
  assert.equal(argOf(brief.args, '--mode'), 'failure');
  assert.equal(argOf(brief.args, '--step'), 'baseline');
  assert.equal(argOf(brief.args, '--settled'), '1', '结算已完成必须写明,否则用户会去手工补数');
  assert.equal(argOf(brief.args, '--consecutive'), '1');
  h1.cleanup();
});

test('T63: 失败日期记入 skipped_dates 并去重排序', () => {
  const h = harness({ fail: { render: 1 } });
  const db = h.readState();
  assert.equal(h.res.outcome, 'failed_after_settle');
  assert.deepEqual(db.skipped_dates, ['2026-07-29'], '记的是本该产出的 id');
  h.cleanup();
});

test('T64: 权威库读不出来时绝不新建 —— 一次写入就会覆盖整部历史', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-db-'));
  const p = path.join(tmp, 'predictions.json');
  assert.equal(R.recordSkippedDate(p, '2026-07-29'), false, '文件不存在时不得创建');
  assert.equal(fs.existsSync(p), false);
  fs.writeFileSync(p, '{ 半截的 JSON');
  assert.equal(R.recordSkippedDate(p, '2026-07-29'), false);
  fs.writeFileSync(p, JSON.stringify({ predictions: [], skipped_dates: ['2026-07-29'] }));
  assert.equal(R.recordSkippedDate(p, '2026-07-29'), false, '已有则不重复记');
  assert.equal(R.recordSkippedDate(p, '2026-07-24'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf-8')).skipped_dates, ['2026-07-24', '2026-07-29']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T65: 降级报告的每个数字都来自 baseline,不含任何新增数值', () => {
  const bl = baselineFixture();
  const md = R.buildDegradedForecast({ baseline: bl, reason: '自检 3 轮未通过' });
  const doc = require('../references/scripts/forecast-parser').parseForecast(md);
  assert.deepEqual(doc.json.horizons.short, { prob_up: 0.53, direction: 'up', low: 3978, high: 4067 });
  assert.equal(doc.json.horizons.long.direction, 'up');
  // 七段必须齐全:parser 用下一个中文序号当右边界,缺「二、」第一段就整段解析不出来
  for (const s of ['一', '二', '三', '四', '五', '六', '七']) {
    assert.ok(doc.sections[s], `第${s}段缺失,parser 会连第一段一起丢掉`);
  }
  assert.ok(doc.sections['一'].includes('降级'));
  // 正文里出现的数字必须都能在 baseline 里找到(日期先剥掉,与 validate 的 stripDates 同口径)
  const allowed = new Set(['0.53', '0.57', '0.6', '0.60', '3978', '4067', '3930', '4116',
                           '3830', '4225', '4022.2', '1', '5', '20', '3']);
  const prose = doc.sections['一'].replace(/\d{4}-\d{2}-\d{2}/g, ' ');
  for (const m of prose.match(/\d+(?:\.\d+)?/g) || []) {
    assert.ok(allowed.has(m), `降级正文出现了 baseline 里没有的数字 ${m}`);
  }
});

test('T66: 待删清单显式列出逐轮产物与报告,不做通配删除', () => {
  const list = R.artifactsToDelete({ workDir: '/w', rounds: 2 });
  assert.deepEqual(list, ['/w/prompt-r1.txt', '/w/forecast-r1.md', '/w/findings-r1.json',
                          '/w/prompt-r2.txt', '/w/forecast-r2.md', '/w/findings-r2.json',
                          '/w/report.html', '/w/report.md', '/w/record.json']);
});

test('T67: 中间产物只落 work/,正式路径上不出现 partial', () => {
  const h = harness({ findingsSeq: [{ passed: false, findings: [{ check: 'C1' }] }, { passed: true, findings: [] }] });
  const inWork = (p) => path.dirname(p) === path.join(h.stateDir, 'work');
  assert.ok(inWork(h.work.forecast(1)) && inWork(h.work.reportHtml) && inWork(h.work.record));
  // 归档目录只由 commit.js 写;编排层自己一个字节都不往里放
  assert.equal(fs.existsSync(h.archiveDir), false);
  for (const n of ['forecast-r1.md', 'report.html', 'record.json', 'findings-r1.json']) {
    assert.equal(fs.existsSync(h.S(n)), false, `${n} 不得落在正式路径上`);
  }
  h.cleanup();
});

test('T68: 进模型的 prompt 里没有 data_quality', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-run-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const S = (n) => path.join(stateDir, n);
  const write = (p, v) => fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  let seenPrompt = '';
  R.runPipeline({
    stateDir, archiveDir: path.join(tmp, 'archive'), log: () => {},
    callModelImpl: (text) => { seenPrompt = text; return { ok: true, kind: 'ok', model: 'MiniMax-M3', attempts: [], text: GOOD_FORECAST }; },
    runScriptImpl: (name, args) => {
      if (name === 'collect-settlement') write(S('settlement-price.json'), { latest: { date: '2026-07-28', value: 4022.2 }, history: [] });
      if (name === 'scorecard') {
        write(argOf(args, '--out'), { by_horizon: { short: { n: 25 } },
          data_quality: [{ horizon: 'short', group: 'naive', field: 'brier', dropped: 7 }] });
      }
      if (name === 'collect-facts') write(argOf(args, '--out'), FACTS);
      if (name === 'baseline') write(argOf(args, '--out'), baselineFixture());
      if (name === 'validate') write(argOf(args, '--out'), { passed: true, findings: [] });
      if (name === 'render') { write(argOf(args, '--out-html'), '<html>'); write(argOf(args, '--out-md'), '# md'); }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.ok(seenPrompt.includes('统计校准'), 'scorecard 应当进了 prompt');
  assert.equal(seenPrompt.includes('data_quality'), false, '模型看得见却不在 C4 允许池里');
  assert.equal(seenPrompt.includes('"dropped"'), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
