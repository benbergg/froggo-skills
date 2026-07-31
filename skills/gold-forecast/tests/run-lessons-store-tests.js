'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyLessons } = require('../references/scripts/lib/lessons-store');

// 造 scorecard:lessons 给 trials/hits,by_horizon.final 给退休基准
function mkScorecard({ lessons = {}, final = {} } = {}) {
  const mkFinal = (o) => (o === null ? null : {
    n: 30, dir_rate: 0.50, brier: 0.2, winkler: 100,
    in_range_rate: 0.60, beat_baseline_rate: 0.70, ...o,
  });
  return {
    by_horizon: {
      short: { insufficient_sample: final.short === null,
                final: final.short === null ? null : mkFinal(final.short) },
      medium: { insufficient_sample: false, final: mkFinal({}) },
      long: { insufficient_sample: false, final: mkFinal({}) },
    },
    lessons,
  };
}

const mkLesson = (o = {}) => ({
  id: 'L001', text: '区间偏窄', tag: 'pre_cpi', metric: 'range', horizon: 'short',
  created: '2026-07-10', evidence: ['2026-07-09'], status: 'active', ...o,
});

test('T1: trials>=5 且 hits=0 → retired_ineffective', () => {
  const sc = mkScorecard({ lessons: { L001: { trials: 5, hits: 0 } } });
  const { lessons } = applyLessons({ current: [mkLesson()], incoming: [], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons[0].status, 'retired_ineffective');
});

test('T2: trials>=5 且命中率>=基准 → retired', () => {
  // metric=range ⇒ 基准取 in_range_rate=0.60;4/5=0.8 >= 0.6
  const sc = mkScorecard({ lessons: { L001: { trials: 5, hits: 4 } } });
  const { lessons } = applyLessons({ current: [mkLesson()], incoming: [], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons[0].status, 'retired');
});

test('T3: trials<5 不退休', () => {
  const sc = mkScorecard({ lessons: { L001: { trials: 4, hits: 0 } } });
  const { lessons } = applyLessons({ current: [mkLesson()], incoming: [], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons[0].status, 'active');
});

test('T4: 命中率低于基准但 hits>0 ⇒ 继续 active', () => {
  // 1/5=0.2 < in_range_rate 0.60,且 hits≠0 ⇒ 两条退休路径都不满足
  const sc = mkScorecard({ lessons: { L001: { trials: 5, hits: 1 } } });
  const { lessons } = applyLessons({ current: [mkLesson()], incoming: [], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons[0].status, 'active');
});

test('T5: 基准按 metric 对齐 —— range 取 in_range_rate 而非 dir_rate', () => {
  // 三个率刻意取不同值:dir_rate 0.50 / in_range_rate 0.90 / beat_baseline_rate 0.70
  // 命中率 3/5=0.6:若错拿 dir_rate(0.50) 会判 retired,正确拿 in_range_rate(0.90) 应继续 active
  const sc = mkScorecard({ lessons: { L001: { trials: 5, hits: 3 } }, final: { short: { in_range_rate: 0.90 } } });
  const { lessons } = applyLessons({ current: [mkLesson()], incoming: [], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons[0].status, 'active');
});

test('T6: metric=brier 取 beat_baseline_rate', () => {
  // beat_baseline_rate 0.70;3/5=0.6 < 0.7 ⇒ active。若错拿 dir_rate(0.50) 会判 retired
  const sc = mkScorecard({ lessons: { L001: { trials: 5, hits: 3 } } });
  const { lessons } = applyLessons({
    current: [mkLesson({ metric: 'brier' })], incoming: [], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons[0].status, 'active');
});

test('T7: insufficient_sample 不触发 retired,但 hits=0 仍触发 retired_ineffective', () => {
  const scA = mkScorecard({ lessons: { L001: { trials: 9, hits: 9 } }, final: { short: null } });
  const a = applyLessons({ current: [mkLesson()], incoming: [], scorecard: scA, createdId: '2026-08-03' });
  assert.equal(a.lessons[0].status, 'active', '基准不可得 ⇒ 不判 retired');

  const scB = mkScorecard({ lessons: { L001: { trials: 9, hits: 0 } }, final: { short: null } });
  const b = applyLessons({ current: [mkLesson()], incoming: [], scorecard: scB, createdId: '2026-08-03' });
  assert.equal(b.lessons[0].status, 'retired_ineffective', 'hits=0 不依赖基准');
});

test('T8: retired* 不参与判定,永不回流', () => {
  const sc = mkScorecard({ lessons: { L001: { trials: 20, hits: 20 } } });
  const { lessons } = applyLessons({
    current: [mkLesson({ status: 'retired_ineffective' })], incoming: [], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons[0].status, 'retired_ineffective');
});

test('T9: current 非数组 ⇒ 抛错,不静默当空库', () => {
  const sc = mkScorecard();
  assert.throws(() => applyLessons({ current: { L001: {} }, incoming: [], scorecard: sc, createdId: '2026-08-03' }),
    /必须是数组/);
});

test('T10: scorecard.lessons 里没有该 id ⇒ 不退休', () => {
  const sc = mkScorecard({ lessons: {} });
  const { lessons } = applyLessons({ current: [mkLesson()], incoming: [], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons[0].status, 'active');
});
