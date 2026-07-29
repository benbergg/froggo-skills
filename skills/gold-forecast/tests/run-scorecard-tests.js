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

// —— C-2:置信分箱不得有浮点漂移,两套口径须一致 ——

test('T18: 0.05 整数倍置信度落对箱(浮点累加会整体错位一档)', () => {
  const cases = [[0.60, 0.60], [0.65, 0.65], [0.70, 0.70], [0.75, 0.75],
                 [0.80, 0.80], [0.85, 0.85], [0.90, 0.90], [0.95, 0.95]];
  for (const [conf, expectLo] of cases) {
    const db = mkDb(25, { probUp: conf });
    const buckets = buildScorecard(db, {}).by_horizon.short.calibration_buckets;
    assert.equal(buckets.length, 1, `conf=${conf} 应只落一箱`);
    assert.equal(buckets[0].range[0], expectLo,
      `conf=${conf} 应落 [${expectLo},…),实得 [${buckets[0].range.join(',')}]`);
    assert.equal(buckets[0].n, 25);
  }
});

test('T19: 同箱内两个不同置信度不被劈成两箱', () => {
  const db = mkDb(25, { probUp: 0.60 });
  db.predictions.slice(0, 12).forEach((p) => { p.horizons.short.final.prob_up = 0.64; });
  const buckets = buildScorecard(db, {}).by_horizon.short.calibration_buckets;
  assert.equal(buckets.length, 1, '0.60 与 0.64 同属 [0.60,0.65),劈开会让 claimed/actual 建在错误成员集上');
  assert.ok(Math.abs(buckets[0].claimed - (12 * 0.64 + 13 * 0.60) / 25) < 1e-9);
});

test('T20: by_confidence 与 calibration_buckets 对同一 conf 归属一致', () => {
  // 两套口径一律下闭上开;0.65 落 [0.65,0.70) 就必须同时算进 gt65
  for (const conf of [0.55, 0.60, 0.65, 0.70]) {
    const sc = buildScorecard(mkDb(25, { probUp: conf }), {}).by_horizon.short;
    const lo = sc.calibration_buckets[0].range[0];
    const coarse = Object.entries(sc.by_confidence).find(([, v]) => v.n === 25)[0];
    const expect = lo >= 0.65 ? 'gt65' : lo >= 0.55 ? '55to65' : 'lt55';
    assert.equal(coarse, expect, `conf=${conf} 细箱下界 ${lo} 与粗档 ${coarse} 打架`);
  }
});

test('T21: conf=1.0 不被整箱丢弃', () => {
  const buckets = buildScorecard(mkDb(25, { probUp: 1 }), {}).by_horizon.short.calibration_buckets;
  assert.equal(buckets.length, 1, '末档上闭,否则 100% 置信的预测在校准曲线里凭空消失');
  assert.equal(buckets[0].n, 25);
  assert.deepEqual(buckets[0].range, [0.95, 1], '须归入末档而非凭空多出 [1.0,1.05) 这种箱');
});

// —— I-1:非有限值不得被 a+b 当 0 吸收 ——

test('T22: 缺失 winkler 不被当 0 拉低均值,且显式上报', () => {
  const db = mkDb(25);
  db.predictions.slice(0, 5).forEach((p) => { p.horizons.short.score.winkler = null; });
  const sc = buildScorecard(db, {});
  assert.equal(sc.by_horizon.short.final.winkler, 100, '20 条真实宽度均为 100,不得被稀释成 80');
  const q = sc.data_quality.find((x) => x.horizon === 'short' && x.group === 'final' && x.field === 'winkler');
  assert.ok(q, '剔除必须留回执,否则与「样本不足」的 null 同形');
  assert.equal(q.dropped, 5);
});

test('T23: 字段整列缺失时给 null 而非 NaN', () => {
  const db = mkDb(25);
  db.predictions.forEach((p) => { delete p.horizons.short.score.winkler; });
  const sc = buildScorecard(db, {});
  assert.equal(sc.by_horizon.short.final.winkler, null, 'NaN 序列化后也是 null,但会污染后续算术');
  assert.equal(sc.data_quality.find((x) => x.group === 'final' && x.field === 'winkler').dropped, 25);
});

test('T24: 缺失 dir_correct 不被静默计为判错', () => {
  const db = mkDb(25);
  db.predictions.slice(0, 5).forEach((p) => { delete p.horizons.short.score.dir_correct; });
  const sc = buildScorecard(db, {});
  assert.equal(sc.by_horizon.short.final.dir_rate, 1, '剩余 20 条全对,不得报成 0.8');
  assert.ok(sc.data_quality.some((x) => x.group === 'final' && x.field === 'dir_correct' && x.dropped === 5));
});

// —— I-3:最近 3 期按结算时序取,不按数组下标 ——

test('T25: 乱序 append 时「最近 3 期」仍指向结算最晚的 3 条', () => {
  const db = mkDb(25);
  db.predictions.forEach((p, i) => { p.horizons.short.settled_date = `2026-02-${String(i + 1).padStart(2, '0')}`; });
  // 最旧 3 条搬到数组末尾:long 周期天然乱序到达,按下标取必然指错
  const oldest = db.predictions.splice(0, 3);
  oldest.forEach((p) => { p.horizons.short.score.brier = 0.9; });
  db.predictions.push(...oldest);
  const sc = buildScorecard(db, {});
  assert.ok(!sc.review_triggers.some((x) => x.kind === 'final_worse_than_baseline'),
    '劣于基线的是最旧 3 条,不应触发「最近连续 3 期」');
});

test('T26: 结算时序最晚的 3 条劣于基线才触发,且 ids 为这 3 条', () => {
  const db = mkDb(25);
  db.predictions.forEach((p, i) => { p.horizons.short.settled_date = `2026-02-${String(i + 1).padStart(2, '0')}`; });
  const latest = db.predictions.slice(-3).map((p) => p.id);
  for (const id of latest) db.predictions.find((p) => p.id === id).horizons.short.score.brier = 0.9;
  db.predictions.reverse();
  const t = buildScorecard(db, {}).review_triggers.find((x) => x.kind === 'final_worse_than_baseline');
  assert.ok(t, '乱序不应掩盖真实的连续劣化');
  assert.deepEqual(t.ids.slice().sort(), latest.slice().sort());
});

// —— I-6:naive 行内部须同源 ——

test('T27: naive dir_rate 按 naive_p 判方向,与 naive_brier 同一预测器', () => {
  const db = mkDb(25);
  // naive_p<0.5 即看跌;实际全涨 ⇒ 命中率应为 0,而非「恒猜涨」口径的 1
  db.predictions.forEach((p) => { p.horizons.short.score.naive_p = 0.4; p.horizons.short.actual = 4010; });
  assert.equal(buildScorecard(db, {}).by_horizon.short.naive.dir_rate, 0);

  const db2 = mkDb(25);
  db2.predictions.forEach((p) => { p.horizons.short.score.naive_p = 0.6; p.horizons.short.actual = 4010; });
  assert.equal(buildScorecard(db2, {}).by_horizon.short.naive.dir_rate, 1);
});

test('T28: naive_p 恰为 0.5 判跌,与 settle 的 prob_up>0.5 口径一致', () => {
  const db = mkDb(25);
  db.predictions.forEach((p) => { p.horizons.short.score.naive_p = 0.5; p.horizons.short.actual = 4010; });
  assert.equal(buildScorecard(db, {}).by_horizon.short.naive.dir_rate, 0);
});

test('T29: 记录缺 naive_p 时按 0.5 兜底并上报', () => {
  const sc = buildScorecard(mkDb(25), {});
  assert.ok(sc.data_quality.some((x) => x.horizon === 'short' && x.field === 'naive_p' && x.dropped === 25));
});

// —— 现状锁定:阈值边界与方向 ——

test('T30: current_streak 只记连败,连胜为 0', () => {
  assert.equal(buildScorecard(mkDb(25), {}).by_horizon.short.current_streak, 0, '连胜不计正数');
  const db = mkDb(25);
  db.predictions.slice(-4).forEach((p) => { p.horizons.short.score.dir_correct = false; });
  assert.equal(buildScorecard(db, {}).by_horizon.short.current_streak, -4);
});

test('T31: range_bias 上破计 above、下破计 below,端点不计', () => {
  const db = mkDb(25);
  db.predictions.slice(0, 3).forEach((p) => { p.horizons.short.actual = 4060; });   // high=4050
  db.predictions.slice(3, 5).forEach((p) => { p.horizons.short.actual = 3940; });   // low=3950
  db.predictions.slice(5, 7).forEach((p) => { p.horizons.short.actual = 4050; });   // 恰在上界
  const rb = buildScorecard(db, {}).by_horizon.short.range_bias;
  assert.equal(rb.above, 3);
  assert.equal(rb.below, 2);
});

test('T32: 三条触发器均在「恰好等于阈值」时不触发', () => {
  const eq = mkDb(25);
  eq.predictions.slice(-3).forEach((p) => { p.horizons.short.score.brier = p.horizons.short.score.baseline_brier; });
  assert.ok(!buildScorecard(eq, {}).review_triggers.some((x) => x.kind === 'final_worse_than_baseline'));

  const inv = mkDb(40);
  inv.predictions.slice(0, 20).forEach((p) => { p.horizons.short.final.prob_up = 0.7; p.horizons.short.score.dir_correct = true; });
  inv.predictions.slice(20).forEach((p) => { p.horizons.short.final.prob_up = 0.52; p.horizons.short.score.dir_correct = true; });
  assert.ok(!buildScorecard(inv, {}).review_triggers.some((x) => x.kind === 'confidence_inversion'));

  const c9 = mkDb(20);
  c9.predictions.forEach((p, i) => { p.c9_triggered = i < 12; });   // 12/20 = 60%,恰等阈值
  assert.ok(!buildScorecard(c9, {}).review_triggers.some((x) => x.kind === 'c9_high_rate'));
});

test('T33: 教训无效触发器以 trials>=5 为界', () => {
  const run = (trials) => {
    const db = mkDb(trials + 1, { tags: ['pre_cpi'] });   // 创建当日那条不计入 trials
    db.predictions.forEach((p) => { p.horizons.short.score.dir_correct = false; });
    return buildScorecard(db, { lessons: [{ id: 'L1', tag: 'pre_cpi', metric: 'dir', horizon: 'short', created: '2026-01-01', status: 'active' }] });
  };
  assert.ok(!run(4).review_triggers.some((x) => x.kind === 'lesson_ineffective'), 'trials=4 不触发');
  assert.ok(run(5).review_triggers.some((x) => x.kind === 'lesson_ineffective'), 'trials=5 触发');
});

// —— brier_series:报告的「三方演化曲线」唯一数据源 ——
// 没有它,渲染层只能拿三个聚合标量连成折线冒充趋势,而读者会把它当趋势记住。

test('T34: brier_series 每期一点,按 id 升序,三方齐全', () => {
  const s = buildScorecard(mkDb(25), {}).by_horizon.short.brier_series;
  assert.equal(s.length, 25, '序列长度须等于样本数,不是三个聚合点');
  const ids = s.map((p) => p.id);
  assert.deepEqual(ids, [...ids].sort(), '按 p.id 升序');
  for (const k of ['final', 'baseline', 'naive']) assert.ok(Number.isFinite(s[0][k]), `缺 ${k}`);
});

test('T35: 是累积均值而非逐条值', () => {
  // 前 10 条判错(brier 0.3364)、后 15 条判对(0.1764):逐条值会在第 11 点直接跳到 0.1764,
  // 累积均值只会缓慢下行,末点必须等于聚合 brier。
  const sc = buildScorecard(mkDb(25, { dirOk: (i) => i >= 10 }), {}).by_horizon.short;
  const s = sc.brier_series;
  assert.ok(Math.abs(s[0].final - 0.3364) < 1e-9, '首点等于首条值');
  assert.ok(Math.abs(s[10].final - (10 * 0.3364 + 0.1764) / 11) < 1e-9, '第 11 点是前 11 条的均值');
  assert.ok(Math.abs(s[24].final - sc.final.brier) < 1e-9, '末点必须与聚合 brier 相等');
  assert.ok(s[10].final > s[24].final, '累积均值单向收敛,不该跟着逐条值跳变');
});

test('T36: 样本不足时为 null,不给半截曲线', () => {
  assert.equal(buildScorecard(mkDb(10), {}).by_horizon.short.brier_series, null);
});

test('T37: 非有限值被跳过而非当 0 计入', () => {
  const db = mkDb(25);
  db.predictions.slice(0, 5).forEach((p) => { p.horizons.short.score.baseline_brier = null; });
  const s = buildScorecard(db, {}).by_horizon.short.brier_series;
  assert.equal(s[0].baseline, null, '一条有效值都没有时给 null');
  assert.ok(Math.abs(s[24].baseline - 0.2209) < 1e-9, '剩余 20 条均为 0.2209,不得被 0 稀释成 0.1767');
});

test('T38: 乱序 append 不影响序列顺序', () => {
  const db = mkDb(25);
  const shuffled = { ...db, predictions: [...db.predictions].reverse() };
  assert.deepEqual(
    buildScorecard(shuffled, {}).by_horizon.short.brier_series,
    buildScorecard(db, {}).by_horizon.short.brier_series,
    '曲线的横轴是日期,不能是 db.predictions 的插入次序');
});
