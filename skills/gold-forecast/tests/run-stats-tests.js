'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../references/scripts/lib/stats');

test('T1: normInv 对拍已知分位点', () => {
  assert.ok(Math.abs(S.normInv(0.9) - 1.2815515655) < 1e-6, '80% 双侧区间用的就是这个值');
  assert.ok(Math.abs(S.normInv(0.975) - 1.9599639845) < 1e-6);
  assert.ok(Math.abs(S.normInv(0.5)) < 1e-12);
});

test('T2: normInv 对称', () => {
  assert.ok(Math.abs(S.normInv(0.3) + S.normInv(0.7)) < 1e-9);
});

test('T3: logistic 能拟合线性可分数据', () => {
  const X = [[-2], [-1], [1], [2]];
  const y = [0, 0, 1, 1];
  const beta = S.fitLogistic(X, y);
  assert.ok(beta[1] > 0, '斜率应为正');
  assert.ok(S.predictLogistic(beta, [2]) > 0.5);
  assert.ok(S.predictLogistic(beta, [-2]) < 0.5);
});

test('T4: logistic 在无信息数据上退回基础率', () => {
  const X = [[1], [1], [1], [1]];
  const y = [1, 0, 1, 0];
  const p = S.predictLogistic(S.fitLogistic(X, y), [1]);
  assert.ok(Math.abs(p - 0.5) < 0.05, `无信息时应接近 0.5,实得 ${p}`);
});

test('T5: NW 在 lag=0 时退化为样本方差/n', () => {
  const d = [1, -1, 2, -2, 3, -3, 1, -1];
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const g0 = d.reduce((a, x) => a + (x - mean) ** 2, 0) / d.length;
  assert.ok(Math.abs(S.neweyWestVar(d, 0) - g0 / d.length) < 1e-9);
});

test('T6: NW 对正自相关序列给出更大方差', () => {
  const d = [1, 1, 1, 1, -1, -1, -1, -1, 1, 1, 1, 1];   // 强正自相关
  assert.ok(S.neweyWestVar(d, 3) > S.neweyWestVar(d, 0),
    '忽略自相关会低估方差,进而把噪声判成显著');
});

test('T7: DM 对同分布损失给不出显著性', () => {
  const a = [0.25, 0.24, 0.26, 0.25, 0.24, 0.26, 0.25, 0.24, 0.26, 0.25, 0.24, 0.26];
  const b = a.slice();
  const { p } = S.dieboldMariano(a, b, { lag: 2 });
  assert.ok(p > 0.5, `完全相同的损失不应显著,实得 p=${p}`);
});

test('T8: DM 对稳定优势给出显著性', () => {
  // 两边各自独立的确定性抖动,使损失差真有方差 ——
  // 若两边抖动相同,差值恒为常数,方差只剩浮点噪声,这条就测不到显著性了。
  const a = Array.from({ length: 200 }, (_, i) => 0.30 + 0.05 * Math.sin(i * 1.1));
  const b = Array.from({ length: 200 }, (_, i) => 0.20 + 0.05 * Math.sin(i * 2.3));
  const { stat, p } = S.dieboldMariano(a, b, { lag: 3 });
  assert.ok(stat > 0, 'a 损失更大,stat 应为正');
  assert.ok(p < 0.01, `稳定优势应显著,实得 p=${p}`);
});

test('T9: DM 结果与损失顺序反号对称', () => {
  // 沿用 T8 手法,两边独立抖动避免差值退化成浮点伪影
  const a = Array.from({ length: 100 }, (_, i) => 0.3 + 0.05 * Math.sin(i * 1.3));
  const b = Array.from({ length: 100 }, (_, i) => 0.2 + 0.05 * Math.sin(i * 2.7));
  const f = S.dieboldMariano(a, b, { lag: 2 });
  const r = S.dieboldMariano(b, a, { lag: 2 });
  assert.ok(Math.abs(f.stat + r.stat) < 1e-9);
  assert.ok(Math.abs(f.p - r.p) < 1e-12);
});
