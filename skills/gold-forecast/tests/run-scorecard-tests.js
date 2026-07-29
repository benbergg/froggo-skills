'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildScorecard } = require('../references/scripts/scorecard');

// 造 n 条已结算记录,dirOk 控制方向对错;horizon 决定哪个周期结算(默认 short,向后兼容)
function mkDb(n, { dirOk = () => true, degradedIdx = [], probUp = 0.58, tags = [], horizon = 'short' } = {}) {
  const predictions = [];
  const sessionsOf = { short: 1, medium: 5, long: 20 };
  for (let i = 0; i < n; i++) {
    const horizons = {
      short: { n_sessions: 1, settled: false },
      medium: { n_sessions: 5, settled: false },
      long: { n_sessions: 20, settled: false },
    };
    horizons[horizon] = {
      n_sessions: sessionsOf[horizon], settled: true, settled_kind: 'exact', actual: 4010,
      final: { prob_up: probUp, low: 3950, high: 4050 },
      baseline: { prob_up: 0.53, low: 3940, high: 4060 },
      score: {
        dir_correct: dirOk(i), brier: dirOk(i) ? 0.1764 : 0.3364,
        in_range: true, winkler: 100,
        baseline_brier: 0.2209, baseline_winkler: 120,
        baseline_dir_correct: true, naive_brier: 0.2256,
      },
    };
    predictions.push({
      id: `2026-01-${String(i + 1).padStart(2, '0')}`,
      base_price: 4000, degraded: degradedIdx.includes(i),
      model_id: 'minimax/MiniMax-M3', context_tags: tags,
      horizons,
    });
  }
  return { schema_version: 2, predictions, skipped_dates: [] };
}

test('T1: 样本不足时三组指标为 null 并标记', () => {
  const sc = buildScorecard(mkDb(10), {});
  const s = sc.by_horizon.short;
  assert.equal(s.insufficient_sample, true);
  assert.equal(s.final, null);
  assert.equal(s.baseline, null);
  assert.equal(s.naive, null);
  assert.equal(s.n, 10, '样本数仍须报出');
});

test('T2: 样本足够时给出三方对照', () => {
  const sc = buildScorecard(mkDb(25), {});
  const s = sc.by_horizon.short;
  assert.equal(s.insufficient_sample, false);
  assert.ok(s.final.brier > 0 && s.baseline.brier > 0 && s.naive.brier > 0);
  assert.equal(s.naive.winkler, null, 'naive 组不产生区间,Winkler 应为 null');
});

test('T3: 聚合 Brier 是各条单条 Brier 的平均', () => {
  const sc = buildScorecard(mkDb(25), {});
  assert.ok(Math.abs(sc.by_horizon.short.final.brier - 0.1764) < 1e-9,
    '全对时应等于单条值本身');
});

test('T4: degraded 记录被排除并单列', () => {
  const sc = buildScorecard(mkDb(25, { degradedIdx: [0, 1, 2, 3] }), {});
  assert.equal(sc.by_horizon.short.n, 21, 'degraded 不计入三方对照');
  assert.equal(sc.excluded.degraded, 4);
});

test('T5: 覆盖率含 skipped / abandoned / approx 计数', () => {
  const db = mkDb(25);
  db.skipped_dates = ['2026-02-01', '2026-02-02'];
  db.predictions[0].horizons.short.settled_kind = 'approx';
  db.predictions[1].horizons.short = { n_sessions: 1, settled: false, status: 'abandoned' };
  const sc = buildScorecard(db, {});
  assert.equal(sc.coverage.skipped, 2);
  assert.equal(sc.coverage.approx, 1);
  assert.equal(sc.coverage.abandoned, 1);
});

test('T6: 分置信档统计能检出倒挂', () => {
  const db = mkDb(40, { dirOk: (i) => i % 2 === 1 });
  // 前 20 条设为高置信,且全部判错
  db.predictions.slice(0, 20).forEach((p) => { p.horizons.short.final.prob_up = 0.7; p.horizons.short.score.dir_correct = false; });
  db.predictions.slice(20).forEach((p) => { p.horizons.short.final.prob_up = 0.52; p.horizons.short.score.dir_correct = true; });
  const sc = buildScorecard(db, {});
  const c = sc.by_horizon.short.by_confidence;
  assert.equal(c.gt65.dir_rate, 0);
  assert.equal(c.lt55.dir_rate, 1);
});

test('T7: 触发器 —— final 连续 3 期劣于 baseline', () => {
  const db = mkDb(25);
  db.predictions.slice(-3).forEach((p) => { p.horizons.short.score.brier = 0.9; });
  const sc = buildScorecard(db, {});
  const t = sc.review_triggers.find((x) => x.kind === 'final_worse_than_baseline');
  assert.ok(t, '应触发定向复核');
  assert.equal(t.ids.length, 3);
  assert.equal(t.horizon, 'short', 'trigger 需标明触发周期');
});

test('T8: 触发器 —— 高置信档胜率低于低置信档', () => {
  const db = mkDb(40);
  db.predictions.slice(0, 20).forEach((p) => { p.horizons.short.final.prob_up = 0.7; p.horizons.short.score.dir_correct = false; });
  db.predictions.slice(20).forEach((p) => { p.horizons.short.final.prob_up = 0.52; p.horizons.short.score.dir_correct = true; });
  const sc = buildScorecard(db, {});
  const t = sc.review_triggers.find((x) => x.kind === 'confidence_inversion');
  assert.ok(t);
  assert.equal(t.horizon, 'short', 'trigger 需标明触发周期');
});

test('T9: 系统健康时不产生任何触发器', () => {
  const sc = buildScorecard(mkDb(25), {});
  assert.deepEqual(sc.review_triggers, [], '健康时不应打扰');
});

// —— lessons 统计:hit 判据随 metric 而变 ——
// 若一律用 dir_correct,区间类教训永远学不会。

test('T10: metric=range 的教训按 in_range 计 hit', () => {
  const db = mkDb(5, { tags: ['pre_cpi'] });
  db.predictions.forEach((p) => { p.horizons.short.score.in_range = false; p.horizons.short.score.dir_correct = true; });
  const lessons = [{ id: 'L003', tag: 'pre_cpi', metric: 'range', horizon: 'short', created: '2025-01-01', status: 'active' }];
  const sc = buildScorecard(db, { lessons });
  assert.equal(sc.lessons.L003.trials, 5);
  assert.equal(sc.lessons.L003.hits, 0, '方向全对但区间全破,range 类教训 hit 应为 0');
});

test('T11: metric=dir 的教训按 dir_correct 计 hit', () => {
  const db = mkDb(5, { tags: ['pre_cpi'] });
  db.predictions.forEach((p) => { p.horizons.short.score.in_range = false; p.horizons.short.score.dir_correct = true; });
  const lessons = [{ id: 'L900', tag: 'pre_cpi', metric: 'dir', horizon: 'short', created: '2025-01-01', status: 'active' }];
  const sc = buildScorecard(db, { lessons });
  assert.equal(sc.lessons.L900.hits, 5);
});

test('T12: 创建当日那次不计入 trials', () => {
  const db = mkDb(3, { tags: ['pre_cpi'] });
  const lessons = [{ id: 'L1', tag: 'pre_cpi', metric: 'dir', horizon: 'short', created: '2026-01-01', status: 'active' }];
  const sc = buildScorecard(db, { lessons });
  assert.equal(sc.lessons.L1.trials, 2, '创建日那条是证据不是检验');
});

test('T13: 触发器 —— 某教训连续 5 次无效', () => {
  const db = mkDb(6, { tags: ['pre_cpi'] });
  db.predictions.forEach((p) => { p.horizons.short.score.dir_correct = false; });
  const lessons = [{ id: 'L1', tag: 'pre_cpi', metric: 'dir', horizon: 'short', created: '2026-01-01', status: 'active' }];
  const sc = buildScorecard(db, { lessons });
  assert.ok(sc.review_triggers.some((x) => x.kind === 'lesson_ineffective' && x.lesson_id === 'L1'));
});

test('T14: 从零重算幂等 —— 同输入必得同输出', () => {
  const db = mkDb(25);
  const a = JSON.stringify(buildScorecard(db, {}).by_horizon);
  const b = JSON.stringify(buildScorecard(JSON.parse(JSON.stringify(db)), {}).by_horizon);
  assert.equal(a, b, 'scorecard 必须是纯函数投影');
});

test('T15: 按 model_id 分组', () => {
  const db = mkDb(25);
  db.predictions.slice(0, 5).forEach((p) => { p.model_id = 'other/model'; });
  const sc = buildScorecard(db, {});
  assert.ok(sc.by_model['minimax/MiniMax-M3']);
  assert.ok(sc.by_model['other/model']);
});

// —— 设计 §5.4.1 触发器表四条:前两条不应写死在 short,三周期同速累积样本 ——

test('T16: 触发器扩展到三周期 —— long 周期连续 3 期劣于 baseline', () => {
  const db = mkDb(25, { horizon: 'long' });
  db.predictions.slice(-3).forEach((p) => { p.horizons.long.score.brier = 0.9; });
  const sc = buildScorecard(db, {});
  const t = sc.review_triggers.find((x) => x.kind === 'final_worse_than_baseline' && x.horizon === 'long');
  assert.ok(t, '应对 long 周期独立触发定向复核');
  assert.equal(t.ids.length, 3);
});

test('T17: 触发器 —— C9 触发率超阈值', () => {
  const db = mkDb(20);
  db.predictions.forEach((p, i) => { p.c9_triggered = i < 14; }); // 14/20 = 70%
  const sc = buildScorecard(db, {});
  const t = sc.review_triggers.find((x) => x.kind === 'c9_high_rate');
  assert.ok(t, '70% > 60% 阈值应触发');
  assert.equal(t.ids.length, 3);

  const db2 = mkDb(20);
  db2.predictions.forEach((p, i) => { p.c9_triggered = i < 10; }); // 10/20 = 50%
  const sc2 = buildScorecard(db2, {});
  assert.ok(!sc2.review_triggers.some((x) => x.kind === 'c9_high_rate'), '50% 不应触发');
});
