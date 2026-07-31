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

test('T70: 二进制找不到/没执行位判 infra,不判 oversize', () => {
  // OPENCLAW_BIN 配错、npm 全局目录被清、丢执行位 —— 判 oversize 会把运维引向查
  // prompt 体积,而 SKILL.md 自己把 openclaw 路径列为第一条排查项。
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'ENOMEM']) {
    const r = R.interpretModelResult({ status: null, signal: null, stdout: '', error: { code } }, 'MiniMax-M3');
    assert.equal(r.kind, 'infra', `${code} 应判 infra`);
    assert.match(r.stderr, new RegExp(code), '简报要能指到具体 errno');
  }
});

test('T71: callModel 打不存在的二进制时判 infra(端到端,不起真 openclaw)', () => {
  const r = R.callModel('p', { bin: '/no/such/openclaw/binary' });
  assert.equal(r.kind, 'infra', '进程根本没起来,与 prompt 体积无关');
});

test('T90: error 存在但没有 code 时仍判 infra', () => {
  // 白名单键在 error **是否存在**,不是 error.code 是否有值。键在 code 上时,
  // 一个没有 .code 的 error 会掉进 status===null 的 oversize 兜底 —— 同一类误判换个入口。
  for (const err of [{}, { message: 'spawn failed' }, { errno: -8 }]) {
    const r = R.interpretModelResult({ status: null, signal: null, stdout: '', error: err }, 'MiniMax-M3');
    assert.equal(r.kind, 'infra', `error=${JSON.stringify(err)} 应判 infra`);
  }
  // 对照:完全没有 error 才是 E2BIG 的实测签名
  assert.equal(R.interpretModelResult({ status: null, signal: null, stdout: '' }, 'M').kind, 'oversize');
});

test('T72: 白名单只放行 E2BIG —— 未知 errno 一律归环境故障', () => {
  assert.equal(R.interpretModelResult({ status: null, stdout: '', error: { code: 'E2BIG' } }, 'M').kind, 'oversize');
  assert.equal(R.interpretModelResult({ status: null, stdout: '', error: { code: 'E2BIG_LOOKALIKE' } }, 'M').kind, 'infra');
  // 无 error 无 signal 的裸 status=null 仍是 E2BIG 的实测签名,不能一起吞掉
  assert.equal(R.interpretModelResult({ status: null, stdout: '' }, 'M').kind, 'oversize');
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
function harness({ fail = {}, findingsSeq = null, modelSeq = null, baseline = null,
                   stderrs = {}, ...opts } = {}) {
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
        // 写 --out 指到哪就写哪(dry-run 下那是沙箱副本),桩不许自作主张写真路径
        write(argOf(args, '--out'), { series: 'lbma_pm_usd', latest: { date: '2026-07-28', value: 4022.2 },
          history: [{ date: '2026-07-27', value: 4010 }, { date: '2026-07-28', value: 4022.2 }], freshness_ok: true });
      }
      if (name === 'scorecard') write(argOf(args, '--out'), { by_horizon: {}, coverage: {}, data_quality: [], review_triggers: [] });
      if (name === 'collect-facts') write(argOf(args, '--out'), FACTS);
      if (name === 'baseline') write(argOf(args, '--out'), baseline || baselineFixture());
      if (name === 'validate') write(argOf(args, '--out'), (findings && findings.shift()) || { passed: true, findings: [] });
      if (name === 'render') { write(argOf(args, '--out-html'), '<html></html>'); write(argOf(args, '--out-md'), '# md'); }
    }
    return { code, stdout: '', stderr: stderrs[name] || `${name} stub`, timedOut: false };
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
      write(argOf(args, '--out'), { latest: { date: '2026-07-28', value: 4022.2 },
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

test('T69: CLI 参数错退 1,不退 5 —— 5 的语义是运行期异常/权威库损坏', () => {
  const { spawnSync } = require('node:child_process');
  const { withBlockNetwork } = require('./helpers');
  const script = path.join(__dirname, '..', 'references', 'scripts', 'run.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-cli-'));
  // 子进程不继承 runner 的 NODE_OPTIONS(这里给的是白名单 env),必须自己注入断网 shim。
  // 不注入的话下面那条 --dry-run 会跑完整 runPipeline,Step 1a 真打 LBMA 端点。
  const run = (args) => spawnSync(process.execPath, [script, ...args],
    { encoding: 'utf-8', timeout: 20_000,
      env: { PATH: process.env.PATH, HOME: tmp, NODE_OPTIONS: withBlockNetwork() } });
  assert.equal(run(['--help']).status, 0);
  assert.equal(run(['--nope']).status, 1, '未知参数');
  assert.equal(run([]).status, 1, '缺 archive-dir');
  assert.equal(run(['--today', '2026/7/29', '--dry-run']).status, 1, '非法日期是参数错,不是运行期异常');
  // 缺收件人必须在开跑前就拦住:跑完整条流水线(含模型费用)才发现配错了太晚
  const noTarget = run(['--archive-dir', tmp, '--state-dir', tmp]);
  assert.equal(noTarget.status, 1);
  assert.match(noTarget.stderr, /GOLD_FEISHU_TARGET/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T87: --dry-run 无需 archive-dir,能越过参数层进到流水线(且全程离线)', () => {
  const { spawnSync } = require('node:child_process');
  const { withBlockNetwork } = require('./helpers');
  const script = path.join(__dirname, '..', 'references', 'scripts', 'run.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-cli-'));
  const r = spawnSync(process.execPath, [script, '--dry-run', '--state-dir', tmp],
    { encoding: 'utf-8', timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: tmp, NODE_OPTIONS: withBlockNetwork() } });
  // 原断言是 `status !== 5`,通网断网都成立 —— 近乎空断言,还掩盖了真实出网。
  // 现在钉死两件事:①越过了参数层(不是 1)②确实进到了 Step 1a 并因断网而失败(6)。
  assert.equal(r.status, 6, `--dry-run 应越过参数层进流水线,实得 ${r.status}: ${r.stderr.slice(0, 300)}`);
  assert.match(r.stderr, /NET-BLOCKED/, '这一步本来就在打真实 LBMA 端点,shim 必须拦到');
  assert.match(r.stderr, /collect-settlement/);
  assert.equal(/GOLD_FEISHU_TARGET|archive-dir/.test(r.stderr), false, 'dry-run 不该要求这两项');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T73: 失败简报带上具体签名,且不合成与 push 码表撞车的退出码', () => {
  for (const [kind, re] of [['oversize', /参数超长/], ['infra', /模型 API|运行环境/]]) {
    const h = harness({ modelSeq: [{ ok: false, kind }, { ok: false, kind }, { ok: false, kind }] });
    const brief = h.calls.find((c) => c.name === 'push');
    const step = argOf(brief.args, '--step');
    assert.match(step, /^model/, '步骤名仍要在最前');
    assert.match(step, re, `${kind} 的签名没进到人手上的那条消息里`);
    // push.js 的码表里 1=参数错、4=发送失败;模型故障没有子进程退出码,
    // 合成一个数字会让同一个数字在两处含义不同
    assert.equal(brief.args.includes('--code'), false, `${kind} 不该合成退出码`);
    h.cleanup();
  }
});

test('T74: 有真子进程退出码时照常透传,不被签名逻辑吃掉', () => {
  const h = harness({ fail: { baseline: 3 } });
  const brief = h.calls.find((c) => c.name === 'push');
  assert.equal(argOf(brief.args, '--step'), 'baseline', '非 infra 类不加签名后缀');
  assert.equal(argOf(brief.args, '--code'), '3');
  h.cleanup();
});

// ---- 不变量:进 prompt 的每个数字都必须能被 C4 引用 ----------------------

const V = require('../references/scripts/validate');
const SCHEMA = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'references', 'schemas', 'facts.schema.json'), 'utf-8'));

// 独立于 validate.deepNumbers 另写一遍:测试要能在被测实现改坏时仍照自己的口径遍历
function numericLeaves(obj, out = []) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'number') { if (Number.isFinite(obj)) out.push(obj); return out; }
  if (Array.isArray(obj)) { obj.forEach((v) => numericLeaves(v, out)); return out; }
  if (typeof obj === 'object') { Object.values(obj).forEach((v) => numericLeaves(v, out)); return out; }
  return out;
}

// 真实形态:scorecard 顶层各段齐全,baseline 带 features/sigma_d,facts 带派生字段
const RICH_FACTS = {
  schema_version: 1, target_date: '2026-07-28', prev_session: '2026-07-27',
  context_tags: ['pre_cpi'], sigma_pctile: 0.83,
  fields: {
    'lbma.pm_usd': { status: 'ok', value: 4022.2, observed_date: '2026-07-28', available_date: '2026-07-28' },
    'fred.DFII10': { status: 'ok', value: 2.44, observed_date: '2026-07-27', available_date: '2026-07-28' },
    'eastmoney.UDI': { status: 'ok', value: 101.29, observed_date: '2026-07-28', available_date: '2026-07-28' },
  },
  cftc: { net_spec: 183910, net_comm: -213199, spec_pctile: 0.71,
          available_date: '2026-07-22', history_failed_years: [] },
  calendar: { next_releases: [], failed_releases: [] },
  news: { items: [{ title: 'Gold steady', url: 'https://x.com/a', source: 'Reuters' }], status: 'ok' },
  _missing: [],
};
const RICH_SCORECARD = {
  generated_at: '2026-07-28T00:00:00.000Z',
  coverage: { expected: 384, settled: 371, skipped: 2, abandoned: 1, approx: 3 },
  by_horizon: { short: { n: 25, insufficient_sample: false,
    final: { n: 25, dir_rate: 0.571, brier: 0.2377, winkler: 79.1 },
    baseline: { n: 25, dir_rate: 0.558, brier: 0.2431, winkler: 86.4 },
    naive: { n: 25, dir_rate: 0.525, brier: 0.2494, winkler: null } } },
  by_model: { 'MiniMax-M3': { n: 375 } },
  excluded: { degraded: 9 },
  review_triggers: [{ kind: 'c9_high_rate', rate: 0.65, ids: ['2026-07-20'] }],
  lessons: { L001: { trials: 7, hits: 2, metric: 'dir', horizon: 'short', status: 'active' } },
  // 运维诊断:刻意用一个不会与其他数字撞车的值,便于断言它确实没进 payload
  data_quality: [{ horizon: 'short', group: 'naive', field: 'brier', dropped: 9973 }],
};
const FLAT_FACTS = { 'lbma.pm_usd': 4022.2, 'fred.DFII10': 2.44, 'eastmoney.UDI': 101.29,
                     'cftc.net_spec': 183910, 'cftc.net_comm': -213199, 'cftc.spec_pctile': 0.71,
                     _missing: [], news: [] };

const c4On = (numbers) => V.checkC4(
  { json: {}, sections: { 二: numbers.map(String).join(' , ') }, headings: {}, raw: '' },
  { schema: SCHEMA, facts: FLAT_FACTS, facts_raw: RICH_FACTS,
    baseline: baselineFixture(), scorecard: RICH_SCORECARD });

test('T75: 不变量 —— payload 里每个数字都能被 C4 引用(遍历,不是逐字段)', () => {
  const payload = R.promptPayload({ facts: RICH_FACTS, baseline: baselineFixture(), scorecard: RICH_SCORECARD });
  const nums = [...new Set(numericLeaves(payload))];
  assert.ok(nums.length >= 30, `payload 数字太少(${nums.length}),这条断言会变成空跑`);
  const blocked = c4On(nums).map((f) => f.actual);
  assert.deepEqual(blocked, [], `进 prompt 却引用不了的数字:${blocked.join(', ')}`);
});

test('T76: 该拦的仍然拦得住 —— payload 里没有的数字照样 block', () => {
  // 反向控制:T75 若因 C4 被改废(池放到无穷大或 checkC4 恒返回空)而变成空跑,这条会红。
  // 控制值须逐个挑过:C4 的盎司/克白名单是 ×31.1035 且相对容差 0.5%,在大数量级上
  // acceptance band 很宽(实测 123456.78 会被 baseline.low=3978 经 ×31.1035 命中),
  // 随手写一个大数当反例是测不出东西的。
  const blocked = c4On([47, 9973, 61.5, 7777]).map((f) => Number(f.actual));
  for (const n of [47, 61.5, 7777]) assert.ok(blocked.includes(n), `编造的 ${n} 必须被拦`);
  // 9973 只存在于 data_quality,它既不在 payload 也不该在池里 —— 两边一致
  assert.ok(blocked.includes(9973), 'data_quality 的计数不该可引用');
});

test('T77: data_quality 既不进 payload,也不进 C4 池(两边同步剥离)', () => {
  const payload = R.promptPayload({ facts: RICH_FACTS, baseline: baselineFixture(), scorecard: RICH_SCORECARD });
  assert.equal(numericLeaves(payload).includes(9973), false, '运维诊断不该给模型看见');
  assert.equal('data_quality' in payload.scorecard, false);
  assert.ok('data_quality' in RICH_SCORECARD, '不得就地改动调用方对象');
});

test('T78: 设计 8.1 要求第五段写的覆盖率与 abandoned 计数,写得出来', () => {
  // 旧池只取 by_horizon,于是「累计 384 期、已结算 371 期、放弃 1 期」全被 C4 拦下,
  // 等于自检在阻止报告满足设计。
  const doc = { json: {}, headings: {}, raw: '',
    sections: { 五: '累计 384 期,已结算 371 期,逾期放弃 1 期,延迟结算 3 期,降级 9 期不计入统计。' } };
  const findings = V.checkC4(doc, { schema: SCHEMA, facts: FLAT_FACTS, facts_raw: RICH_FACTS,
    baseline: baselineFixture(), scorecard: RICH_SCORECARD });
  assert.deepEqual(findings, [], JSON.stringify(findings));
});

// ---- dry-run 不碰权威库 / 权威库丢失 / 日期口径 / 通知开关 / 源冻结 --------

const QUIET_ENV = { SEND_NOTIFY: '1' };

test('T79: dry-run 失败时不写 skipped_dates、不累计失败连击、不建权威库', () => {
  for (const step of ['settle', 'collect-facts', 'render']) {
    const h = harness({ dryRun: true, fail: { [step]: 1 }, env: QUIET_ENV });
    // 干净目录上演练一次不该留下权威库 —— 部署清单第 5 步就是先演练
    assert.equal(fs.existsSync(h.S('predictions.json')), false, `${step} 失败时 dry-run 建了权威库`);
    assert.equal(fs.existsSync(h.S('run-state.json')), false, `${step} 失败时 dry-run 起了失败连击`);
    // 副本里倒是该有一份,否则等于跳过了这些步骤,演练就白演了
    assert.ok(fs.existsSync(path.join(h.S('work'), 'dry-run-sandbox', 'predictions.json')),
      '副本里应有空库,演练才跑得下去');
    assert.equal(h.order.includes('push'), false);
    h.cleanup();
  }
});

test('T80: 非 dry-run 才写权威库,两者行为必须不同(否则上一条是空跑)', () => {
  const h = harness({ fail: { render: 1 }, env: QUIET_ENV });
  assert.deepEqual(h.readState().skipped_dates, ['2026-07-29']);
  assert.equal(JSON.parse(fs.readFileSync(h.S('run-state.json'), 'utf-8')).consecutive_failures, 1);
  h.cleanup();
});

test('T81: skipped_dates 恒为 target_date 口径,baseline 之前失败也一样', () => {
  // baseline 之后失败 → predictionId;之前失败 → 由 latestSession 现推。
  // 两条路必须落在同一套口径上,否则覆盖率的分母混了两种日期,
  // 而 Set 去重还会把「D 日晚失败」与「D+1 日早失败」并成一天。
  const after = harness({ fail: { render: 1 }, env: QUIET_ENV });
  const before = harness({ fail: { 'collect-facts': 1 }, env: QUIET_ENV });
  assert.deepEqual(after.readState().skipped_dates, ['2026-07-29']);
  assert.deepEqual(before.readState().skipped_dates, ['2026-07-29'],
    `baseline 之前失败记成了 ${before.readState().skipped_dates}(base_date 口径)`);
  after.cleanup(); before.cleanup();
});

test('T82: 首次部署新建空库,库丢失则拒绝新建并退 5', () => {
  const mk = (seed) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-db-'));
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    seed(stateDir);
    const calls = [];
    const res = R.runPipeline({
      stateDir, archiveDir: path.join(tmp, 'archive'), log: () => {}, env: QUIET_ENV,
      callModelImpl: () => { throw new Error('不该走到模型'); },
      runScriptImpl: (name) => {
        calls.push(name);
        if (name === 'collect-settlement') {
          fs.writeFileSync(path.join(stateDir, 'settlement-price.json'),
            JSON.stringify({ latest: { date: '2026-07-28', value: 4022.2 }, history: [] }));
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    return { res, calls, stateDir, tmp };
  };

  const fresh = mk(() => {});
  assert.ok(fs.existsSync(path.join(fresh.stateDir, 'predictions.json')), '首次部署应新建空库');
  assert.notEqual(fresh.res.outcome, 'failed_before_settle');
  fs.rmSync(fresh.tmp, { recursive: true, force: true });

  // 跑过的痕迹 + 库不见了 = 丢失,不是首次部署
  for (const seed of [
    (d) => fs.writeFileSync(path.join(d, 'run-state.json'), '{"last_outcome":"success"}'),
    (d) => { fs.mkdirSync(path.join(d, 'versions'), { recursive: true });
             fs.writeFileSync(path.join(d, 'versions', 'predictions.json.1753000000000.1.000000'), '{}'); },
  ]) {
    const gone = mk(seed);
    assert.equal(gone.res.exitCode, 5, '权威库丢失必须退 5,不能静默重开局');
    assert.equal(fs.existsSync(path.join(gone.stateDir, 'predictions.json')), false, '绝不新建空库');
    assert.equal(gone.calls.includes('settle'), false, '不能让 settle 在空库上跑');
    assert.ok(gone.calls.includes('push'), '要发失败简报');
    fs.rmSync(gone.tmp, { recursive: true, force: true });
  }
});

test('T83: predictionsDbState 三态判定', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-dbstate-'));
  const P = { predictions: path.join(tmp, 'predictions.json'), runState: path.join(tmp, 'run-state.json') };
  assert.equal(R.predictionsDbState(P), 'fresh');
  fs.writeFileSync(P.runState, '{}');
  assert.equal(R.predictionsDbState(P), 'missing');
  fs.writeFileSync(P.predictions, '{}');
  assert.equal(R.predictionsDbState(P), 'present', '库在就是在,不管有没有跑过的痕迹');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T84: SEND_NOTIFY 未设时显著告警(通知层静默关闭而退出码是 0)', () => {
  const off = harness({ env: {} });
  assert.equal(off.res.notifyDisabled, true);
  assert.ok(off.logs.some((m) => /SEND_NOTIFY/.test(m)), '必须告警,否则运维以为发出去了');
  assert.equal(off.res.exitCode, 0, '不 fail —— 演练场景合法');
  off.cleanup();

  const on = harness({ env: QUIET_ENV });
  assert.equal(on.res.notifyDisabled, false);
  assert.equal(on.logs.some((m) => /SEND_NOTIFY/.test(m)), false, '设了就不该再吵');
  on.cleanup();

  const dry = harness({ dryRun: true, env: {} });
  assert.equal(dry.res.notifyDisabled, false, 'dry-run 本就不推送,不必为此告警');
  dry.cleanup();
});

test('T85: 连续非交易日计数与失败计数互不污染', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-state-'));
  const p = path.join(tmp, 'run-state.json');
  let s = R.bumpRunState(p, 'non_trading_day');
  assert.equal(s.consecutive_non_trading, 1);
  assert.equal(s.consecutive_failures, 0, '周末不是失败');
  s = R.bumpRunState(p, 'non_trading_day');
  assert.equal(s.consecutive_non_trading, 2);
  s = R.bumpRunState(p, 'failed_after_settle');
  assert.equal(s.consecutive_non_trading, 0, '出现一次真运行就该清零');
  assert.equal(s.consecutive_failures, 1);
  s = R.bumpRunState(p, 'success');
  assert.equal(s.consecutive_failures, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T86: 连续无新定盘达阈值即告警(LBMA 源冻结的兜底)', () => {
  const runOnce = (priorCount) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-stale-'));
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'predictions.json'), JSON.stringify({
      schema_version: 2, skipped_dates: [],
      predictions: [{ id: '2026-07-29', base_date: '2026-07-28', horizons: {} }] }));
    fs.writeFileSync(path.join(stateDir, 'run-state.json'), JSON.stringify({
      last_outcome: 'non_trading_day', consecutive_failures: 0, consecutive_non_trading: priorCount }));
    const calls = [];
    const logs = [];
    const res = R.runPipeline({
      stateDir, archiveDir: path.join(tmp, 'archive'), log: (m) => logs.push(m), env: QUIET_ENV,
      callModelImpl: () => { throw new Error('不该走到模型'); },
      runScriptImpl: (name, args) => {
        calls.push({ name, args });
        if (name === 'collect-settlement') {
          fs.writeFileSync(path.join(stateDir, 'settlement-price.json'),
            JSON.stringify({ latest: { date: '2026-07-28', value: 4022.2 }, history: [] }));
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    return { res, calls, logs };
  };

  // 阈值必须用绝对值钉住:拿 STALE_SESSION_ALERT_RUNS 自己去算种子数,
  // 断言会跟着常量一起缩放 —— 阈值改成 2 也照样绿(实测过),等于没测。
  // 4 是真实日历的上界:复活节周五假 + 周末 + 周一假,圣诞同量级。
  assert.ok(R.STALE_SESSION_ALERT_RUNS >= 5,
    `阈值 ${R.STALE_SESSION_ALERT_RUNS} 会被正常假期误触发,连续告警会训练出忽略习惯`);
  const quiet = runOnce(3);   // 本次运行后计到 4,仍在日历能解释的范围内
  assert.equal(quiet.res.outcome, 'non_trading_day');
  assert.equal(quiet.calls.some((c) => c.name === 'push'), false, '真实假期最长连跑 4 次,不能被误触发');

  const loud = runOnce(R.STALE_SESSION_ALERT_RUNS - 1);
  assert.equal(loud.res.outcome, 'non_trading_day');
  const alert = loud.calls.find((c) => c.name === 'push');
  assert.ok(alert, '源冻结会让系统无限期静默,必须有兜底告警');
  assert.match(argOf(alert.args, '--step'), /stale-lbma/);
  assert.equal(argOf(alert.args, '--mode'), 'failure');
});

test('T88: 每个 spawn **站点**都注入了断网 shim(未来新站点会红)', () => {
  // 按文件扫是不够的:在已经用过 shim 的文件里新增一个未注入的 spawn 站点,
  // 整文件仍然命中 withBlockNetwork ⇒ 440/440 全绿(复审 M14 实测)。改为按站点扫:
  // 每个 spawn 调用点附近都必须出现 NODE_OPTIONS。窗口取调用点前后各若干字符,
  // 因为 opts 常常是先构造好的变量(helpers.runCli 就是)。
  const EXEMPT = {
    'run-history-store-tests.js': '并发写同一 jsonl 的压测,spawn 的是本仓库内的写入脚本,不出网',
  };
  const BEFORE = 900;
  const AFTER = 500;
  const offenders = [];
  let sites = 0;
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.js'))) {
    if (EXEMPT[f]) continue;
    const src = fs.readFileSync(path.join(__dirname, f), 'utf-8');
    for (const m of src.matchAll(/\bspawn(?:Sync)?\s*\(/g)) {
      sites++;
      const window = src.slice(Math.max(0, m.index - BEFORE), m.index + AFTER);
      if (!/NODE_OPTIONS/.test(window)) offenders.push(`${f}@${m.index}`);
    }
  }
  assert.ok(sites >= 3, `只扫到 ${sites} 个 spawn 站点,正则可能失配`);
  assert.deepEqual(offenders, [], `这些 spawn 站点附近没有注入断网 shim:${offenders.join(', ')}`);
});

test('T89b: 调用方传自己的 NODE_OPTIONS 时,子进程仍然被断网(端到端)', () => {
  // T89 测的是 withBlockNetwork 这个纯函数,不是调用点。把 helpers.runCli 改回
  // { NODE_OPTIONS: …, ...env } ⇒ 439/439 全绿(复审 M6 实测)。这条打真链路验调用点:
  // collect-settlement 不传 --fixture 就会去打 LBMA,shim 生效则报 NET-BLOCKED。
  const { runCli } = require('./helpers');
  const r = runCli({
    script: 'collect-settlement.js',
    args: ['--history', 'h', '--out', 'settlement.json'],
    env: { NODE_OPTIONS: '--max-old-space-size=256' },
  });
  assert.match(r.stderr, /NET-BLOCKED/,
    '调用方自己的 NODE_OPTIONS 顶掉了 shim —— 子进程真打了外部端点');
  r.cleanup();
});

test('T89: 调用方自己的 NODE_OPTIONS 顶不掉 shim', () => {
  const { withBlockNetwork } = require('./helpers');
  // 曾经的写法是 { NODE_OPTIONS: shim, ...env },调用方传一个同名键就静默关掉了拦截
  assert.match(withBlockNetwork(), /--require .*block-network\.js/);
  const merged = withBlockNetwork('--max-old-space-size=256');
  assert.match(merged, /--max-old-space-size=256/, '调用方的选项要保留');
  assert.match(merged, /--require .*block-network\.js/, 'shim 必须仍在');
  assert.ok(merged.indexOf('block-network') > merged.indexOf('max-old-space'), 'shim 追加在最后');
});

// ---- 结构性不变量:buildPrompt 拼进 prompt 的每个块都必须表态 --------------

const BP = require('../references/scripts/build-prompt');
const PP = require('../references/scripts/lib/prompt-payload');

const PRIOR_FINDINGS = [{
  check: 'C3', severity: 'block', locator: 'json.horizons.short',
  expected: '区间半宽须落在 [15.00,60.00](基线半宽 30 × [0.5,2])', actual: '6.25',
}];
// 不可引用块各埋一个**逐个验过池里够不到**的哨兵值。这样把任一块的 citable 翻成 true
// (政策表说谎)T92 会立刻红 —— 上一轮 lessons 翻 true 却全绿,正是因为夹具里的
// 18.7 恰好能被 C4 放行(p0_20=0.60 × 31.1035 = 18.6621,相对差 0.2%)。
const SENTINEL = { news: 5150, lessons: 7777, prior_output: 6.25 };
const RICH_LESSONS = [{ id: 'L001', tag: 'pre_cpi', status: 'active', trials: 7,
                        created: '2026-01-01', text: '短周期区间应比基线宽 18.7 点' }];
const SENTINEL_LESSONS = [{ id: 'L001', tag: 'pre_cpi', status: 'active', trials: 7,
                            created: '2026-01-01', text: `短周期区间应比基线宽 ${SENTINEL.lessons} 点` }];

// 按模型读到的形态抽数字:先剥 ISO 日期(与 validate 的 stripDates 同口径),再扫。
// 独立于 validate 的实现另写一遍,免得被测实现改坏时测试跟着一起瞎。
function numbersInText(text) {
  const stripped = String(text).replace(/\d{4}-\d{2}-\d{2}/g, ' ');
  const hits = stripped.match(/(?<![\d.A-Za-z])-?\d[\d,]*(?:\.\d+)?%?/g) || [];
  return [...new Set(hits.map((x) => Number(x.replace(/[,%]/g, ''))))].filter(Number.isFinite);
}

function fullPrompt() {
  const facts = { ...RICH_FACTS, generated_at: '2026-07-28T12:34:56.789Z' };
  const scorecard = { ...RICH_SCORECARD };
  return {
    facts,
    scorecard,
    built: BP.buildPrompt({
      ...PP.promptPayload({ facts, baseline: baselineFixture(), scorecard }),
      lessons: SENTINEL_LESSONS, contextTags: ['pre_cpi'],
      news: [{ title: `Gold tops ${SENTINEL.news} an ounce`, url: 'https://x.com/a', source: 'Reuters' }],
      priorFindings: { round: 1, findings: PRIOR_FINDINGS, forecast: '## 一、今日结论\n半宽 6.25' },
    }),
  };
}

test('T91: 每个 prompt 块都已显式表态可引用性(新增块会红)', () => {
  const names = fullPrompt().built.blocks.map((b) => b.name);
  const declared = Object.keys(PP.BLOCK_CITABILITY);
  const undeclared = names.filter((n) => !declared.includes(n));
  assert.deepEqual(undeclared, [],
    `这些块进了 prompt 却没在 BLOCK_CITABILITY 里表态:${undeclared.join(', ')}`);
  // 反向:声明了却从不出现的条目也要清掉,免得政策表与现实脱节
  const stale = declared.filter((n) => !names.includes(n));
  assert.deepEqual(stale, [], `BLOCK_CITABILITY 里有已不存在的块:${stale.join(', ')}`);
  // 排除必须是显式声明出来的,不是"测试没枚举到"
  for (const [n, p] of Object.entries(PP.BLOCK_CITABILITY)) {
    assert.equal(typeof p.citable, 'boolean', `${n} 未表态`);
    assert.ok(p.reason && p.reason.length > 10, `${n} 的排除/放行理由太短,说不清就是没想清`);
  }
});

test('T92: 结构性不变量 —— 可引用块里的每个数字都在 C4 池中', () => {
  const { built, facts, scorecard } = fullPrompt();
  const ctx = { schema: SCHEMA, facts: FLAT_FACTS, facts_raw: facts,
                baseline: baselineFixture(), scorecard, prior_findings: PRIOR_FINDINGS };
  const failures = [];
  let checkedBlocks = 0;
  for (const b of built.blocks) {
    if (!PP.BLOCK_CITABILITY[b.name].citable) continue;
    const nums = numbersInText(b.text);
    if (!nums.length) continue;
    checkedBlocks++;
    const doc = { json: {}, sections: { 二: nums.join(' , ') }, headings: {}, raw: '' };
    for (const f of V.checkC4(doc, ctx)) failures.push(`${b.name}:${f.actual}`);
  }
  assert.ok(checkedBlocks >= 5, `只检了 ${checkedBlocks} 个块,夹具没把 prompt 填满`);
  assert.deepEqual(failures, [],
    `这些数字模型看得见却引用不了(引用即被 C4 拦下,修复循环会白烧):${failures.join(', ')}`);
});

test('T93: 修复循环的具体场景 —— 模型复述 C3 阈值不会被拦', () => {
  // N-1 的原始失败链:第 1 轮 C3 未过 → 第 2 轮 prompt 写「半宽须落在 [15.00,60.00]」
  // → 模型照做并写「已放宽至 60」→ C4 拦下 60 → 三轮耗尽降级。每轮真付一次 M3 调用。
  const ctx = { schema: SCHEMA, facts: FLAT_FACTS, facts_raw: RICH_FACTS,
                baseline: baselineFixture(), scorecard: RICH_SCORECARD, prior_findings: PRIOR_FINDINGS };
  // 注意措辞:只讲本轮取值与目标区间,**不复述上一轮的错值 6.25** ——
  // 那个数正是自检刚判定为无出处的东西,要求模型复述它本身就是错的期望(C-1)。
  const doc = { json: {}, headings: {}, raw: '',
    sections: { 一: '已将短期区间半宽调整为 60,落入 [15.00, 60.00] 区间。' } };
  assert.deepEqual(V.checkC4(doc, ctx), [], '修复指令自己触发下一条自检');
  // 反向:上一轮的错值不得因为进了 prompt 就变得可引用
  const echo = { json: {}, headings: {}, raw: '', sections: { 一: '上一轮半宽为 6.25。' } };
  assert.equal(V.checkC4(echo, ctx).length, 1, '复述上一轮错值应仍被拦');
});

test('T94: 不可引用块的数字仍然拦得住(排除不是放行)', () => {
  const ctx = { schema: SCHEMA, facts: FLAT_FACTS, facts_raw: RICH_FACTS,
                baseline: baselineFixture(), scorecard: RICH_SCORECARD, prior_findings: PRIOR_FINDINGS };
  // 控制值必须逐个验过是「池里够不到」的:随手写的 4100 会撞上 baseline 的 4116
  // (相对容差 0.5% ⇒ ±20.6),18.7 会被 p0_20=0.6 经 ×31.1035 命中 —— 都测不出东西。
  const ONLY_IN_NEWS = 5150;
  const ONLY_IN_LESSON = 7777;
  const built = BP.buildPrompt({
    ...PP.promptPayload({ facts: RICH_FACTS, baseline: baselineFixture(), scorecard: RICH_SCORECARD }),
    lessons: [{ id: 'L9', tag: 'pre_cpi', status: 'active', trials: 1, created: '2026-01-01',
                text: `区间应比基线宽 ${ONLY_IN_LESSON} 点` }],
    contextTags: ['pre_cpi'],
    news: [{ title: `Gold tops ${ONLY_IN_NEWS} an ounce`, url: 'https://x.com/a', source: 'Reuters' }],
  });
  assert.ok(built.text.includes(String(ONLY_IN_NEWS)), '控制值确实进了 prompt');
  assert.ok(built.text.includes(String(ONLY_IN_LESSON)), '控制值确实进了 prompt');
  const doc = { json: {}, headings: {}, raw: '', sections: { 二: `${ONLY_IN_NEWS} 与 ${ONLY_IN_LESSON}` } };
  const blocked = V.checkC4(doc, ctx).map((f) => Number(f.actual));
  assert.ok(blocked.includes(ONLY_IN_NEWS), '新闻标题里的数字不得成为论据来源');
  assert.ok(blocked.includes(ONLY_IN_LESSON), '教训文本里的数字不得成为论据来源');
});

test('T95: 周期长度是正式字段而非键名副产品', () => {
  // 原先模型只能从 `p0_5`/`p0_20` 的**键名**推出周期长度,而键名里抽出的 5/20 不在池里,
  // 报告写「未来 5 个交易日」就被 C4 拦下。
  const pb = PP.promptBaseline(baselineFixture());
  assert.equal(pb.horizons.short.n_sessions, 1);
  assert.equal(pb.horizons.medium.n_sessions, 5);
  assert.equal(pb.horizons.long.n_sessions, 20);
  assert.equal(pb.horizons.short.prob_up, 0.53, '原有字段不得丢');
  assert.equal(baselineFixture().horizons.short.n_sessions, undefined, '不得就地改动调用方对象');
  const ctx = { schema: SCHEMA, facts: FLAT_FACTS, facts_raw: RICH_FACTS,
                baseline: baselineFixture(), scorecard: RICH_SCORECARD };
  const doc = { json: {}, headings: {}, raw: '', sections: { 一: '中期看未来 5 个交易日,长期看 20 个交易日。' } };
  assert.deepEqual(V.checkC4(doc, ctx), []);
});

test('T96: 运维时间戳不进 payload(其时分秒会被抽成数字)', () => {
  const facts = { ...RICH_FACTS, generated_at: '2026-07-28T12:34:56.789Z' };
  const sc = { ...RICH_SCORECARD, generated_at: '2026-07-28T12:34:56.789Z' };
  const payload = PP.promptPayload({ facts, baseline: baselineFixture(), scorecard: sc });
  assert.equal('generated_at' in payload.facts, false);
  assert.equal('generated_at' in payload.scorecard, false);
  assert.ok('generated_at' in facts && 'generated_at' in sc, '不得就地改动调用方对象');
});

test('T97: 第 2/3 轮把上一轮 findings 同时喂给 prompt 与 C4 池', () => {
  // 池有能力认 findings 数字,不等于编排层真喂了。少了这条,U2 那种"忘了传 --prior-findings"
  // 的回归在单元层测不出来 —— 单元测试是直接给 ctx 的。
  const bad = { passed: false, findings: [{ check: 'C3', locator: 'json.horizons.short',
                                            expected: '区间半宽须落在 [15.00,60.00]', actual: '6.25' }] };
  const h = harness({ findingsSeq: [bad, bad, { passed: true, findings: [] }], env: QUIET_ENV });
  const validates = h.calls.filter((c) => c.name === 'validate');
  assert.equal(validates.length, 3);
  assert.equal(validates[0].args.includes('--prior-findings'), false, '第 1 轮没有上一轮');
  for (const round of [2, 3]) {
    const args = validates[round - 1].args;
    assert.ok(args.includes('--prior-findings'), `第 ${round} 轮未把 findings 传给 validate`);
    assert.equal(argOf(args, '--prior-findings'), h.work.findings(round - 1),
      `第 ${round} 轮传的必须是上一轮的 findings 文件`);
  }
  h.cleanup();
});

// ---- dry-run 的不变量:前后逐字节相同,且不改变后续真实运行的产出 ----------

const crypto = require('node:crypto');

// 目录/文件的逐字节指纹。断言"没调用 settle"会退化成清单;这里断言的是结果。
function treeFingerprint(...targets) {
  const out = [];
  const walk = (p, rel) => {
    if (!fs.existsSync(p)) { out.push(`${rel}:<absent>`); return; }
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const n of fs.readdirSync(p).sort()) walk(path.join(p, n), `${rel}/${n}`);
    } else {
      out.push(`${rel}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  for (const t of targets) walk(t.path, t.rel);
  return out.join('\n');
}

const SEED_DB = {
  schema_version: 2,
  skipped_dates: [],
  predictions: [{
    id: '2026-07-24', base_date: '2026-07-23', base_price: 4000, degraded: false,
    horizons: {
      short: { n_sessions: 1, target_date: '2026-07-24', settled: false,
               baseline: { prob_up: 0.5, low: 3950, high: 4050 },
               final: { prob_up: 0.55, low: 3960, high: 4040 }, naive_p: 0.5 },
      medium: { n_sessions: 5, target_date: '2026-07-30', settled: false },
      long: { n_sessions: 20, target_date: '2026-08-21', settled: false },
    },
  }],
};

// settle 桩:真的按 --predictions 改文件(结算一次性,改了就回不去)
function seededRun({ stateDir, dryRun }) {
  const calls = [];
  const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof v === 'string' ? v : `${JSON.stringify(v, null, 1)}\n`); };
  const res = R.runPipeline({
    stateDir, archiveDir: path.join(stateDir, '..', 'archive'), dryRun, log: () => {}, env: QUIET_ENV,
    callModelImpl: () => ({ ok: true, kind: 'ok', model: 'MiniMax-M3', attempts: [], text: GOOD_FORECAST }),
    runScriptImpl: (name, args) => {
      calls.push(name);
      if (name === 'collect-settlement') {
        write(argOf(args, '--out'), { latest: { date: '2026-07-28', value: 4022.2 },
          history: [{ date: '2026-07-28', value: 4022.2 }] });
        // 采集会往 history/ 追加,这一步同样必须落在副本上
        write(path.join(argOf(args, '--history'), 'lbma_pm_usd.jsonl'),
          '{"observed_date":"2026-07-28","available_date":"2026-07-28","value":4022.2}\n');
      }
      if (name === 'settle') {
        const dbPath = argOf(args, '--predictions');
        const db = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
        for (const p of db.predictions) {
          if (p.horizons.short && !p.horizons.short.settled) {
            p.horizons.short.settled = true;
            p.horizons.short.settled_date = '2026-07-28';
            p.horizons.short.actual = 4022.2;
          }
        }
        write(dbPath, db);
      }
      if (name === 'scorecard') write(argOf(args, '--out'), { by_horizon: {}, data_quality: [] });
      if (name === 'collect-facts') write(argOf(args, '--out'), FACTS);
      if (name === 'baseline') write(argOf(args, '--out'), baselineFixture());
      if (name === 'validate') write(argOf(args, '--out'), { passed: true, findings: [] });
      if (name === 'render') { write(argOf(args, '--out-html'), '<html>'); write(argOf(args, '--out-md'), '# md'); }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  return { res, calls };
}

function seedStateDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-dry-'));
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(path.join(stateDir, 'history'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'predictions.json'), `${JSON.stringify(SEED_DB, null, 1)}\n`);
  fs.writeFileSync(path.join(stateDir, 'history', 'lbma_pm_usd.jsonl'),
    '{"observed_date":"2026-07-27","available_date":"2026-07-27","value":4010}\n');
  return { tmp, stateDir };
}

const authoritative = (stateDir) => [
  { path: path.join(stateDir, 'predictions.json'), rel: 'predictions.json' },
  { path: path.join(stateDir, 'history'), rel: 'history' },
];

test('T98: 一次 dry-run 前后,权威库与 history 逐字节相同', () => {
  const { tmp, stateDir } = seedStateDir();
  const before = treeFingerprint(...authoritative(stateDir));
  const { res, calls } = seededRun({ stateDir, dryRun: true });
  assert.equal(res.outcome, 'success');
  assert.equal(treeFingerprint(...authoritative(stateDir)), before,
    'dry-run 改动了权威库或 history —— 结算一次性不可回改,演练一次就永久写死');
  // 反面:演练不是靠跳过 settle 达成的,副本里必须真被结算过,否则演练毫无价值
  assert.ok(calls.includes('settle'), 'settle 必须照跑,演练存在的意义就是查当天数据对不对');
  const sandboxDb = JSON.parse(fs.readFileSync(
    path.join(stateDir, 'work', 'dry-run-sandbox', 'predictions.json'), 'utf-8'));
  assert.equal(sandboxDb.predictions[0].horizons.short.settled, true, '副本里应当真被结算了');
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'predictions.json'), 'utf-8'))
    .predictions[0].horizons.short.settled, false, '真库不得被结算');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T99: 跑过 dry-run 之后的真实运行,与从未跑过 dry-run 完全一致', () => {
  const a = seedStateDir();
  const b = seedStateDir();
  seededRun({ stateDir: a.stateDir, dryRun: true });   // A 先演练一次
  seededRun({ stateDir: a.stateDir, dryRun: false });
  seededRun({ stateDir: b.stateDir, dryRun: false });  // B 直接真跑
  assert.equal(
    treeFingerprint(...authoritative(a.stateDir)),
    treeFingerprint(...authoritative(b.stateDir)),
    '演练污染了后续真实运行的产出:结算被提前写死,真实运行会被 h.settled 短路跳过',
  );
  fs.rmSync(a.tmp, { recursive: true, force: true });
  fs.rmSync(b.tmp, { recursive: true, force: true });
});

test('T100: 沙箱每次都从当前真库重新复制,不是第一次的残留', () => {
  // 直接比对两次演练的副本是"看起来在测、其实测不到"的:两次都结算成同一个结果,
  // 清不清理都相等(实测变异 V4 不红)。要让它有判别力,必须在两次演练之间改动真库。
  const { tmp, stateDir } = seedStateDir();
  seededRun({ stateDir, dryRun: true });

  const realDb = JSON.parse(fs.readFileSync(path.join(stateDir, 'predictions.json'), 'utf-8'));
  realDb.predictions.push({ id: '2026-07-27', base_date: '2026-07-26', base_price: 4011,
    horizons: { short: { n_sessions: 1, target_date: '2026-07-27', settled: false } } });
  fs.writeFileSync(path.join(stateDir, 'predictions.json'), `${JSON.stringify(realDb, null, 1)}\n`);

  // 残留探针:真库里没有这个 series,清理生效的话第二次演练后它不该还在。
  // 只比对 predictions.json 是测不到清理的 —— 它每次都被 copyFileSync 覆盖(变异 V4 不红)。
  // 真正会残留的是"真库里已经不存在、副本里还留着"的文件,那会让演练读到早已删掉的数据。
  const stale = path.join(stateDir, 'work', 'dry-run-sandbox', 'history', 'ghost_series.jsonl');
  fs.writeFileSync(stale, '{"observed_date":"1999-01-01","available_date":"1999-01-01","value":1}\n');

  seededRun({ stateDir, dryRun: true });
  const sandbox = JSON.parse(fs.readFileSync(
    path.join(stateDir, 'work', 'dry-run-sandbox', 'predictions.json'), 'utf-8'));
  assert.equal(sandbox.predictions.length, 2,
    '副本没跟上真库 —— 第二次演练看不到真库的新数据');
  assert.equal(fs.existsSync(stale), false,
    '副本没重建 —— 真库里已不存在的数据仍留在演练环境里,演练结论不可信');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T101: 演练同样识别权威库丢失,不因沙箱而看成首次部署', () => {
  // dbState 若判在副本上:副本里 run-state.json 与 versions/ 都不存在 ⇒ 恒判 fresh
  // ⇒ 一台丢了库的机器上演练一路绿灯,而真实运行会退 5。两者结论必须一致。
  const { tmp, stateDir } = seedStateDir();
  fs.writeFileSync(path.join(stateDir, 'run-state.json'), '{"last_outcome":"success"}');
  fs.rmSync(path.join(stateDir, 'predictions.json'));
  const { res } = seededRun({ stateDir, dryRun: true });
  assert.equal(res.exitCode, 5, '演练必须和真实运行一样认出权威库丢失');
  assert.equal(fs.existsSync(path.join(stateDir, 'predictions.json')), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T102: build-prompt 超限不合成撞车退出码,且文案指向 100KB 预算而非 128KB', () => {
  // baseline 是不可截断块,塞爆它就能让 buildPrompt fail-fast(与内核 E2BIG 是两回事)
  const huge = { ...baselineFixture(), blob: 'B'.repeat(200_000) };
  const h = harness({ baseline: huge, env: QUIET_ENV });
  assert.equal(h.res.outcome, 'infra_failure');
  assert.equal(h.res.failureKind, 'oversize');
  assert.equal(h.res.failedStep, 'build-prompt');
  const brief = h.calls.find((c) => c.name === 'push');
  const step = argOf(brief.args, '--step');
  assert.match(step, /^build-prompt/);
  assert.match(step, /100KB/, '照 128KB 去量会发现 prompt 才 101KB,转而怀疑消息本身');
  assert.equal(/128KB/.test(step), false, '这条路撞的不是内核上限');
  assert.equal(brief.args.includes('--code'), false,
    '合成的 1 会与 push.js 码表的「1=参数错」撞车,同一个数字两处含义不同');
  h.cleanup();
});

test('T103: 模型侧 E2BIG 的文案仍指向内核 128KB,两条路不混为一谈', () => {
  const h = harness({ modelSeq: [{ ok: false, kind: 'oversize' }], env: QUIET_ENV });
  const step = argOf(h.calls.find((c) => c.name === 'push').args, '--step');
  assert.match(step, /^model/);
  assert.match(step, /128KB/);
  assert.equal(/100KB/.test(step), false);
  h.cleanup();
});

test('T104: C4 自己产的 finding 不得给被拦数字发放行券(端到端,真 validate CLI)', () => {
  // 复审的实测:同一份 forecast 只差一个 --prior-findings,51737 从被拦变成放行。
  // 第 1 轮编造 → C4 block → 第 2 轮 prompt 带着 finding(actual:"51737")+ 上一轮原文全文
  // → 模型照抄 → 放行 → 入库推送。修复循环反过来给编造背书。
  const { runCli } = require('./helpers');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-c1-'));
  const w = (n, v) => { const p = path.join(tmp, n);
    fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); return p; };
  const FAKE = 51737;
  const forecast = [
    '```json', JSON.stringify({ horizons: AI_HORIZONS }), '```', '',
    `## 一、今日结论`, `COMEX 库存 ${FAKE} 吨。`, '',
    '## 二、市场事实', 'x', '', '## 三、对手盘结构', 'x', '', '## 四、判断依据', 'x', '',
    '## 五、上期结算与反思', 'x', '', '## 六、如何使用本区间', 'x', '', '## 七、免责声明', 'x',
  ].join('\n');
  const fp = w('forecast.md', forecast);
  const factsPath = w('facts.json', { fields: {}, _missing: [], news: { items: [] } });
  const blPath = w('baseline.json', baselineFixture());
  const scPath = w('scorecard.json', RICH_SCORECARD);
  const pfPath = w('findings-r1.json', [{ check: 'C4', severity: 'block',
    locator: `第一段:「${FAKE}」`, expected: '数字须能在 facts/baseline/scorecard 中找到',
    actual: String(FAKE) }]);

  const hit = (extra) => {
    const out = path.join(tmp, `out-${Math.random()}.json`);
    const r = runCli({ script: 'validate.js',
      args: ['--forecast', fp, '--facts', factsPath, '--baseline', blPath,
        '--scorecard', scPath, '--out', out, ...extra] });
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(fs.readFileSync(out, 'utf-8')).findings
      .some((f) => f.check === 'C4' && Number(f.actual) === FAKE);
  };
  assert.equal(hit([]), true, '基准:编造的数字本该被 C4 拦下');
  assert.equal(hit(['--prior-findings', pfPath]), true,
    '带上 --prior-findings 后放行 —— C4 给自己刚拦下的数字发了放行券');

  // run.js 传的是 findings-r{n}.json 整个文件,形态是 validate 的产物 {passed, findings}
  // 而非裸数组。上面那个夹具是裸数组 ⇒ 这条路径在生产上第 2 轮必崩,套件却全绿。
  const prodPath = w('findings-prod.json', { passed: false, findings: [{ check: 'C4',
    severity: 'block', locator: `第一段:「${FAKE}」`,
    expected: '数字须能在 facts/baseline/scorecard 中找到', actual: String(FAKE) }] });
  assert.equal(hit(['--prior-findings', prodPath]), true,
    'validate 必须认 validate 自己的产物形态,否则第 2 轮自检 TypeError 崩掉');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- 不变量的另一半:池不得宽于 prompt ----------------------------------

test('T105: 被剥掉的运维字段既不进 payload,也不进 C4 池(表驱动)', () => {
  // 上一轮只有 scorecard 侧有守护(T76/T77 的 data_quality),facts 侧裸奔:
  // 把 validate 改成 deepNumbers(ctx.facts_raw) 绕过投影 ⇒ 439/439 全绿。
  // 这里按 OPS_ONLY_* 表逐键验,新增运维字段自动被覆盖。
  const cases = [
    { label: 'facts', keys: PP.OPS_ONLY_FACTS_KEYS,
      build: (k, v) => ({ facts: { ...RICH_FACTS, [k]: v }, scorecard: RICH_SCORECARD }) },
    { label: 'scorecard', keys: PP.OPS_ONLY_SCORECARD_KEYS,
      build: (k, v) => ({ facts: RICH_FACTS, scorecard: { ...RICH_SCORECARD, [k]: v } }) },
  ];
  let checked = 0;
  for (const c of cases) {
    assert.ok(c.keys.length > 0, `${c.label} 的运维字段表为空,这条会变成空跑`);
    for (const key of c.keys) {
      // 用数值哨兵:今天 generated_at 是字符串、deepNumbers 看不见它,所以这条守的是
      // **机制**——任何落在运维键下的数字都既不该被看见也不该可引用。
      const SENT = 8631;
      const { facts, scorecard } = c.build(key, SENT);
      const payload = PP.promptPayload({ facts, baseline: baselineFixture(), scorecard });
      assert.equal(numericLeaves(payload).includes(SENT), false,
        `${c.label}.${key} 的数字进了 payload`);
      const doc = { json: {}, headings: {}, raw: '', sections: { 二: String(SENT) } };
      const blocked = V.checkC4(doc, { schema: SCHEMA, facts: FLAT_FACTS, facts_raw: facts,
        baseline: baselineFixture(), scorecard }).length;
      assert.equal(blocked, 1, `${c.label}.${key} 的数字可引用 —— 池宽于 prompt,等于放行编造`);
      checked++;
    }
  }
  assert.ok(checked >= 3, `只验了 ${checked} 个运维字段`);
});

test('T106: citable:false 的一侧也由机器校验(政策不能说谎)', () => {
  // 上一轮把 lessons 翻成 true 全绿 —— citable 字段没有被任何断言消费。
  // 现在夹具里每个不可引用块都埋了验过的哨兵,翻 true 会被 T92 抓到;
  // 这条再从反方向钉一次:哨兵必须确实被拦。
  const INJECTABLE = { news: SENTINEL.news, lessons: SENTINEL.lessons, prior_output: SENTINEL.prior_output };
  // contract 是固定模板,没有注入点;且其示例数字在 C4 容差下都能命中真实池值
  // (0.58/3987/4059 经盎司换算、0.5 来自 C3 目标的 × [0.5,2]),无法用哨兵法校验。
  const UNINJECTABLE = { contract: '固定模板,无注入点,示例数字在 C4 容差下均可命中池值' };

  const declaredFalse = Object.entries(PP.BLOCK_CITABILITY)
    .filter(([, v]) => !v.citable).map(([k]) => k).sort();
  const covered = [...Object.keys(INJECTABLE), ...Object.keys(UNINJECTABLE)].sort();
  assert.deepEqual(declaredFalse, covered,
    '新增不可引用块必须要么埋哨兵、要么在 UNINJECTABLE 里写明为什么不能');

  const ctx = { schema: SCHEMA, facts: FLAT_FACTS, facts_raw: RICH_FACTS,
                baseline: baselineFixture(), scorecard: RICH_SCORECARD, prior_findings: PRIOR_FINDINGS };
  const built = fullPrompt().built;
  for (const [name, value] of Object.entries(INJECTABLE)) {
    const block = built.blocks.find((b) => b.name === name);
    assert.ok(block, `${name} 块未出现在夹具里,哨兵是摆设`);
    assert.ok(block.text.includes(String(value)), `${name} 的哨兵 ${value} 没进块`);
    const doc = { json: {}, headings: {}, raw: '', sections: { 二: String(value) } };
    assert.equal(V.checkC4(doc, ctx).length, 1, `${name} 声明不可引用,但其数字 ${value} 在池里`);
  }
});

test('T107: 已声明的块名与 build-prompt 的发射点静态对齐(条件块也算)', () => {
  // T91 只枚举夹具**实际触发**的块 —— 把新块写成条件触发且夹具不触发就能绕过,
  // 而 prior_findings 自己就是条件块,上一轮漏网正是这个形态。这里改为静态扫源码。
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'references', 'scripts', 'build-prompt.js'), 'utf-8');
  const emitted = [...src.matchAll(/\{\s*name:\s*'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.ok(emitted.length >= 8, `只扫到 ${emitted.length} 个发射点,正则可能失配`);
  const declared = Object.keys(PP.BLOCK_CITABILITY).sort();
  assert.deepEqual([...new Set(emitted)], declared,
    'build-prompt 的发射点与 BLOCK_CITABILITY 不一致 —— 条件块不会因夹具没触发而豁免');
});

// —— MF-2:calibration 块随结算样本线性膨胀且不可截断 ——

const { buildScorecard } = require('../references/scripts/scorecard');

// 造 n 条三期全结算的记录,只为量 calibration 块体积
function settledDb(n) {
  const predictions = [];
  for (let i = 0; i < n; i++) {
    const horizons = {};
    for (const [k, ns] of Object.entries({ short: 1, medium: 5, long: 20 })) {
      horizons[k] = { n_sessions: ns, settled: true, settled_kind: 'exact', actual: 4010,
        final: { prob_up: 0.58, low: 3950, high: 4050 }, baseline: { prob_up: 0.53, low: 3940, high: 4060 },
        score: { dir_correct: i % 3 !== 0, brier: i % 3 !== 0 ? 0.1764 : 0.3364, in_range: true,
          winkler: 100, baseline_brier: 0.2209, baseline_winkler: 120,
          baseline_dir_correct: true, naive_brier: 0.2256, naive_p: 0.51 } };
    }
    predictions.push({ id: `p-${String(i).padStart(5, '0')}`, base_price: 4000, degraded: false,
      model_id: 'minimax/MiniMax-M3', context_tags: [], horizons });
  }
  return { schema_version: 2, predictions, skipped_dates: [] };
}

const calibrationBytes = (scorecard) => Buffer.byteLength(
  BP.buildPrompt({ facts: RICH_FACTS, baseline: baselineFixture(), scorecard, lessons: [], contextTags: [], news: [] })
    .blocks.find((b) => b.name === 'calibration').text);

test('T108: calibration 块不随已结算样本增长(否则 250 条起每天 exit 7)', () => {
  // 先钉住这确实是个会撞上限的量级 —— 否则下面的上界断言可能只是因为夹具太小。
  // 实测 250 条已到 10 万字节量级、约 260 条越过 100KB,300 条稳超。
  const raw = buildScorecard(settledDb(300), {});
  const unstripped = Buffer.byteLength('## 统计校准\n```json\n' + JSON.stringify(raw, null, 1) + '\n```');
  assert.ok(unstripped > BP.MAX_BYTES,
    `未剥离时 300 条只有 ${unstripped} 字节,没超过 ${BP.MAX_BYTES},这条测不到东西`);

  const small = calibrationBytes(PP.promptScorecard(buildScorecard(settledDb(25), {})));
  const big = calibrationBytes(PP.promptScorecard(buildScorecard(settledDb(600), {})));
  assert.ok(big < 10 * 1024, `600 条时 calibration 仍应恒定在几 KB,实得 ${big}`);
  assert.ok(big - small < 2048, `块体积随样本增长了 ${big - small} 字节,说明还有随 n 膨胀的字段`);
  // calibration 不可截断,所以它自己就必须装得下;而 buildPrompt 整体也不该抛错
  assert.ok(big < BP.MAX_BYTES / 2);
});

test('T109: 剥掉 brier_series 不减少任何模型可引用的数字(末点恒等于已有聚合值)', () => {
  for (const n of [25, 100, 600]) {
    const sc = buildScorecard(settledDb(n), {});
    for (const k of ['short', 'medium', 'long']) {
      const h = sc.by_horizon[k];
      const last = h.brier_series[h.brier_series.length - 1];
      assert.equal(last.final, h.final.brier, `${k}@${n} 末点应等于聚合 final.brier`);
      assert.equal(last.baseline, h.baseline.brier, `${k}@${n} 末点应等于聚合 baseline.brier`);
      assert.equal(last.naive, h.naive.brier, `${k}@${n} 末点应等于聚合 naive.brier`);
    }
    const p = PP.promptScorecard(sc);
    for (const k of ['short', 'medium', 'long']) {
      assert.equal('brier_series' in p.by_horizon[k], false, `${k} 的 brier_series 未被剥掉`);
      // 聚合值必须留下 —— 设计 8.1 要求第五段引用三方对照
      assert.equal(p.by_horizon[k].final.brier, sc.by_horizon[k].final.brier);
      assert.equal(p.by_horizon[k].n, sc.by_horizon[k].n);
    }
    assert.ok(Array.isArray(sc.by_horizon.short.brier_series), '不得就地改动调用方对象');
  }
});

test('T110: 聚合 Brier 仍在 C4 池里,序列中间点不在', () => {
  const sc = buildScorecard(settledDb(60), {});
  // 不能用 c4On:它写死了 RICH_SCORECARD(本就没有 brier_series),
  // 于是「剥没剥」两种实现都绿 —— 这里必须把本用例自己的 scorecard 送进 ctx
  const on = (n) => V.checkC4({ json: {}, sections: { 二: String(n) }, headings: {}, raw: '' },
    { schema: SCHEMA, facts: FLAT_FACTS, facts_raw: RICH_FACTS, baseline: baselineFixture(), scorecard: sc });
  const agg = sc.by_horizon.short.final.brier;
  assert.deepEqual(on(agg), [], `聚合 Brier ${agg} 必须可引用`);
  // 找一个与三期任一聚合值都拉开距离(超出 0.5% 容差)的中间点,作为「池里够不到」的控制值
  const aggs = ['short', 'medium', 'long'].flatMap((k) =>
    ['final', 'baseline', 'naive'].map((g) => sc.by_horizon[k][g].brier));
  const mid = sc.by_horizon.short.brier_series.map((p) => p.final)
    .find((v) => Number.isFinite(v) && aggs.every((a) => Math.abs(v - a) > Math.max(0.005 * Math.abs(a), 0.01)));
  assert.ok(mid !== undefined, '夹具里找不到与聚合值拉开距离的中间点,这条测不到东西');
  assert.equal(on(mid).length, 1, `序列中间点 ${mid} 已不在 prompt 里,引用它应被拦`);
});

test('T111: render 仍从 scorecard.json 画出完整序列,不受 payload 剥离影响', () => {
  const { renderReport } = require('../references/scripts/render');
  const sc = buildScorecard(settledDb(30), {});
  const doc = { json: { horizons: {} }, headings: {}, raw: '', sections: {} };
  const { html } = renderReport({ doc, scorecard: sc, baseline: baselineFixture(), settlement: null });
  const m = html.match(/class="ln ln-final" d="([^"]+)"/);
  assert.ok(m, 'brier 曲线应画出来');
  assert.equal((m[1].match(/[ML]/g) || []).length, 30, '顶点数须等于完整序列长度,不是聚合后的三个点');
});

// —— new_lessons 中转:与 predictions.json 同一事务 ——

const FORECAST_WITH_LESSONS = ['```json',
  JSON.stringify({ horizons: AI_HORIZONS, new_lessons: [{ text: '甲', tag: 'pre_cpi',
    metric: 'range', horizon: 'short', evidence: ['2026-07-20'] }] }, null, 1),
  '```', '',
  '## 一、今日结论', '看涨', '',
  '## 七、免责声明', '固定文案'].join('\n');

test('T-R1: 自检通过时 work/new-lessons.json 写出模型给的条目', () => {
  const h = harness({ modelSeq: [{ ok: true, kind: 'ok', model: 'MiniMax-M3',
    attempts: [], text: FORECAST_WITH_LESSONS }] });
  const arr = JSON.parse(fs.readFileSync(h.work.newLessons, 'utf-8'));
  assert.equal(arr.length, 1);
  assert.equal(arr[0].text, '甲');
  h.cleanup();
});

test('T-R2: 降级路径下 new-lessons 落空数组', () => {
  // pin 不符 ⇒ degrade ⇒ doc 来自 buildDegradedForecast,根本没有 new_lessons 字段
  const h = harness({ modelSeq: [{ ok: false, kind: 'pin_mismatch', model: 'VL-01', attempts: [] }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(h.work.newLessons, 'utf-8')), []);
  h.cleanup();
});

test('T-R3: new_lessons 非数组时也落空数组,不把对象透传给 commit', () => {
  const bad = ['```json',
    JSON.stringify({ horizons: AI_HORIZONS, new_lessons: { text: '甲' } }, null, 1),
    '```', '', '## 一、今日结论', '看涨', '', '## 七、免责声明', '固定文案'].join('\n');
  const h = harness({ modelSeq: [{ ok: true, kind: 'ok', model: 'MiniMax-M3', attempts: [], text: bad }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(h.work.newLessons, 'utf-8')), []);
  h.cleanup();
});

test('T-R5: 子进程退 0 但带 WARN 时,编排层仍转述 —— 否则教训库静默卡在上限', () => {
  const h = harness({ stderrs: {
    commit: '入库 2026-07-29 (insert),归档 x,索引 1 页\nWARN: active 已达上限 20,拒收:甲\n' } });
  assert.equal(h.res.exitCode, 0, '退 0 是本条的前提:非 0 那条路径本来就打 stderr');
  assert.ok(h.logs.some((m) => m.includes('active 已达上限')),
    'commit 退 0 时 stderr 被吞 ⇒ 每天丢弃新教训而无人知晓,全程 exit 0');
  assert.equal(h.logs.some((m) => m.includes('入库 2026-07-29')), false,
    '只转述 WARN 行,整段 stderr 倒进日志会把真告警淹掉');
  h.cleanup();
});

test('T-R4: Step 6 的 commit 参数里带 --new-lessons 与 --lessons', () => {
  const h = harness();
  const call = h.calls.find((c) => c.name === 'commit');
  assert.ok(call, 'commit 应被调用');
  assert.ok(call.args.includes('--new-lessons'), 'commit 必须收到 --new-lessons');
  assert.ok(call.args.includes('--lessons'), 'commit 必须收到 --lessons');
  h.cleanup();
});
