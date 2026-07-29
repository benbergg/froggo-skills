'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const BT = require('../references/scripts/backtest');

const mkLoss = (n, v, jitter = 0.001) => Array.from({ length: n }, (_, i) => v + jitter * (i % 3));

// 两边各自独立的抖动,使损失差真有方差 —— 若两边抖动相同,
// 差值恒为常数,方差只剩浮点噪声,显著性就测不到了。
const mkSeries = (n, base, freq) => Array.from({ length: n }, (_, i) => base + 0.03 * Math.sin(i * freq));

test('T1: 改善不足阈值即不通过', () => {
  const r = BT.acceptance({ byHorizon: { short: { baselineLoss: mkLoss(1300, 0.2480), naiveLoss: mkLoss(1300, 0.2490) } } },
    { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.short.passed, false, '改善 0.001 < 0.005 应不通过');
});

test('T2: 改善够大且显著才通过', () => {
  const r = BT.acceptance({ byHorizon: { short: { baselineLoss: mkSeries(1300, 0.24, 1.9), naiveLoss: mkSeries(1300, 0.25, 0.7) } } },
    { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.short.passed, true);
  assert.ok(r.short.brier_gain >= 0.005);
  assert.ok(r.short.dm_p < 0.05);
});

test('T3: 改善够大但不显著则不通过', () => {
  // 大幅波动使 DM 统计量不显著,即便均值差达标
  const base = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.02 : 0.46));
  const naive = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.48 : 0.02));
  const r = BT.acceptance({ byHorizon: { short: { baselineLoss: base, naiveLoss: naive } } },
    { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.short.passed, false, '样本噪声大时不应仅凭均值差放行');
});

test('T4: 未通过的周期给出 fallback 标记', () => {
  const r = BT.acceptance({ byHorizon: { long: { baselineLoss: mkLoss(400, 0.249), naiveLoss: mkLoss(400, 0.2495) } } },
    { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.long.passed, false);
  assert.equal(r.long.fallback, 'p0_N');
});

test('T5: 三期各自独立判定', () => {
  const r = BT.acceptance({ byHorizon: {
    short: { baselineLoss: mkSeries(1300, 0.24, 1.9), naiveLoss: mkSeries(1300, 0.25, 0.7) },
    long: { baselineLoss: mkSeries(1300, 0.2495, 1.9), naiveLoss: mkSeries(1300, 0.2500, 0.7) },
  } }, { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.short.passed, true);
  assert.equal(r.long.passed, false, '某期不过不应牵连其他期');
});

test('T6: DM 的 NW 滞后阶取周期长度(重叠窗口自相关长度)', () => {
  assert.equal(BT.lagFor('short'), 1);
  assert.equal(BT.lagFor('medium'), 5);
  assert.equal(BT.lagFor('long'), 20);
});

test('T7: 样本期不足 5 年直接判不通过', () => {
  const r = BT.acceptance({ byHorizon: { short: { baselineLoss: mkLoss(300, 0.20), naiveLoss: mkLoss(300, 0.25) } } },
    { minGain: 0.005, alpha: 0.05, minSamples: 1200 });
  assert.equal(r.short.passed, false, '样本不足时再漂亮的改善也不可采信');
});

test('T8: 滞后阶必须真正传给 DM,而非仅 lagFor 本身正确', () => {
  // 周期 80 自相关:lag=20 判不显著,若调用处误传 0 则会误判显著
  const period = 80;
  const blk = (i) => (Math.floor(i / period) % 2 === 0 ? 1 : -1);
  const naiveLoss = Array.from({ length: 1300 }, (_, i) => 0.25 + 0.05 * blk(i));
  const baselineLoss = Array.from({ length: 1300 }, () => 0.24);
  const r = BT.acceptance({ byHorizon: { long: { baselineLoss, naiveLoss } } }, { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.long.passed, false, 'lag=20 时本不显著,若通过说明调用处未真正传入 lagFor');
});
