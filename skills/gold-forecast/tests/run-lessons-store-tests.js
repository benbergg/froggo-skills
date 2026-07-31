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

const mkIncoming = (o = {}) => ({
  text: '新教训甲', tag: 'pre_cpi', metric: 'range', horizon: 'short', evidence: ['2026-07-20'], ...o });

test('T11: 新教训入库,字段与 id 形态正确', () => {
  const sc = mkScorecard();
  const { lessons } = applyLessons({ current: [], incoming: [mkIncoming()], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons.length, 1);
  assert.deepEqual(lessons[0], {
    id: 'L001', text: '新教训甲', tag: 'pre_cpi', metric: 'range', horizon: 'short',
    created: '2026-08-03', evidence: ['2026-07-20'], status: 'active' });
});

test('T12: created 一律取 createdId,模型自带的 created 不得覆盖', () => {
  // lessonStats 用 p.id > L.created 排除创建当日。createdId 是 short 的 target_date,
  // 采信模型自带的 created(多半是 base_date)会让当天那条预测反过来算进 trials。
  const sc = mkScorecard();
  const { lessons } = applyLessons({ current: [], scorecard: sc, createdId: '2026-08-03',
    incoming: [mkIncoming({ created: '2026-08-01' })] });
  assert.equal(lessons[0].created, '2026-08-03');
});

test('T13: 幂等 —— 同一份 incoming 连跑两次结果逐字节相同', () => {
  const sc = mkScorecard();
  const a = applyLessons({ current: [], incoming: [mkIncoming()], scorecard: sc, createdId: '2026-08-03' });
  const b = applyLessons({ current: a.lessons, incoming: [mkIncoming()], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(JSON.stringify(b.lessons), JSON.stringify(a.lessons));
  assert.equal(a.lessons.length, 1, '未达上限、未触限流 —— 相同不是因为被拒收');
  assert.deepEqual(b.warnings, [], '重跑走去重路径,静默');
});

test('T14: 每日限流 2 条,WARN 含被丢的 text', () => {
  const sc = mkScorecard();
  const { lessons, warnings } = applyLessons({
    current: [], scorecard: sc, createdId: '2026-08-03',
    incoming: [mkIncoming({ text: '甲' }), mkIncoming({ text: '乙' }), mkIncoming({ text: '丙' })] });
  assert.equal(lessons.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /丙/);
});

test('T15: active 达 20 ⇒ 拒收 + WARN', () => {
  const current = Array.from({ length: 20 }, (_, i) =>
    mkLesson({ id: `L${String(i + 1).padStart(3, '0')}`, text: `旧${i}` }));
  const sc = mkScorecard();
  const { lessons, warnings } = applyLessons({
    current, incoming: [mkIncoming({ text: '新的' })], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons.length, 20);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /新的/);
});

test('T16: 流转在闸门之前 —— 库满 20 但今日 2 条退休 ⇒ 新教训进得来', () => {
  const current = Array.from({ length: 20 }, (_, i) =>
    mkLesson({ id: `L${String(i + 1).padStart(3, '0')}`, text: `旧${i}` }));
  // 前 2 条今日满足 retired_ineffective,释放 2 个名额
  const sc = mkScorecard({ lessons: { L001: { trials: 5, hits: 0 }, L002: { trials: 5, hits: 0 } } });
  const { lessons, warnings } = applyLessons({
    current, incoming: [mkIncoming({ text: '新的' })], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons.length, 21, '顺序反了会先看到 active=20 而拒收');
  assert.equal(lessons.at(-1).text, '新的');
  assert.deepEqual(warnings, []);
});

test('T17: 流转在去重之前 —— 库里已有今日教训时退休仍照跑', () => {
  const current = [mkLesson({ id: 'L001', created: '2026-08-03', text: '新教训甲' })];
  const sc = mkScorecard({ lessons: { L001: { trials: 5, hits: 0 } } });
  const { lessons } = applyLessons({ current, incoming: [mkIncoming()], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons.length, 1, '同 (created,text) 不重复追加');
  assert.equal(lessons[0].status, 'retired_ineffective', '去重路径不得跳过流转');
});

test('T18: text 为空 ⇒ 丢弃 + WARN', () => {
  const sc = mkScorecard();
  const { lessons, warnings } = applyLessons({
    current: [], incoming: [mkIncoming({ text: '   ' })], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /text/);
});

test('T19: id 不复用被退休的序号', () => {
  const current = [mkLesson({ id: 'L003', status: 'retired' })];
  const sc = mkScorecard();
  const { lessons } = applyLessons({ current, incoming: [mkIncoming()], scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons.at(-1).id, 'L004');
});

test('T20: incoming 为 null/undefined ⇒ 视为空,正常返回', () => {
  const sc = mkScorecard();
  const { lessons, warnings } = applyLessons({
    current: [mkLesson()], incoming: null, scorecard: sc, createdId: '2026-08-03' });
  assert.equal(lessons.length, 1);
  assert.deepEqual(warnings, []);
});
