'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshTmp, runCli } = require('./helpers');
const S = require('../references/scripts/settle');

const CAL = ['2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31',
             '2026-08-03', '2026-08-04', '2026-08-05'];

test('T1: 方向为二元,涨判定按 actual > base_price', () => {
  const up = S.scoreOne({ prob_up: 0.58, low: 3987, high: 4059, base_price: 4022.2, actual: 4048.6, naive_p: 0.525 });
  assert.equal(up.dir_correct, true);
  const down = S.scoreOne({ prob_up: 0.58, low: 3987, high: 4059, base_price: 4022.2, actual: 4000, naive_p: 0.525 });
  assert.equal(down.dir_correct, false);
});

test('T2: actual 等于 base_price 计为方向未命中', () => {
  const r = S.scoreOne({ prob_up: 0.58, low: 3900, high: 4100, base_price: 4022.2, actual: 4022.2, naive_p: 0.525 });
  assert.equal(r.dir_correct, false, '相等不算涨');
});

test('T3: 单条 Brier 用 (outcome - prob_up)^2', () => {
  const r = S.scoreOne({ prob_up: 0.58, low: 3987, high: 4059, base_price: 4022.2, actual: 4048.6, naive_p: 0.525 });
  assert.ok(Math.abs(r.brier - 0.1764) < 1e-9, `应为 0.1764,实得 ${r.brier}`);
});

test('T4: naive 单条 Brier 也用 (1-p)^2,不可用聚合式 p(1-p)', () => {
  // 设计 5.4 的警告:两式混用会让基准整体偏移,进而误判 baseline 与 final 优劣。
  const r = S.scoreOne({ prob_up: 0.58, low: 3987, high: 4059, base_price: 4022.2, actual: 4048.6, naive_p: 0.525 });
  assert.ok(Math.abs(r.naive_brier - 0.225625) < 1e-9,
    `上涨样本的 naive_brier 应为 (1-0.525)^2=0.225625,实得 ${r.naive_brier}`);
  assert.ok(Math.abs(r.naive_brier - 0.525 * 0.475) > 1e-6, '不得等于聚合式 p(1-p)');
});

test('T5: Winkler 命中时等于区间宽度', () => {
  const r = S.scoreOne({ prob_up: 0.58, low: 3987, high: 4059, base_price: 4022.2, actual: 4048.6, naive_p: 0.5 });
  assert.equal(r.in_range, true);
  assert.ok(Math.abs(r.winkler - 72) < 1e-9, `应为 72,实得 ${r.winkler}`);
});

test('T6: Winkler 上破时加 10 倍超出量', () => {
  const r = S.scoreOne({ prob_up: 0.58, low: 3987, high: 4059, base_price: 4022.2, actual: 4069, naive_p: 0.5 });
  assert.equal(r.in_range, false);
  assert.ok(Math.abs(r.winkler - (72 + 10 * 10)) < 1e-9, `应为 172,实得 ${r.winkler}`);
});

test('T7: Winkler 下破时加 10 倍不足量', () => {
  const r = S.scoreOne({ prob_up: 0.58, low: 3987, high: 4059, base_price: 4022.2, actual: 3977, naive_p: 0.5 });
  assert.ok(Math.abs(r.winkler - (72 + 10 * 10)) < 1e-9);
});

test('T8: 拉宽区间无法降低 Winkler(堵死保命路)', () => {
  const narrow = S.scoreOne({ prob_up: 0.5, low: 4000, high: 4050, base_price: 4022, actual: 4030, naive_p: 0.5 });
  const wide = S.scoreOne({ prob_up: 0.5, low: 3500, high: 4500, base_price: 4022, actual: 4030, naive_p: 0.5 });
  assert.ok(wide.winkler > narrow.winkler, '过宽区间必须被惩罚,否则命中率可被刷满');
});

// —— 三状态机 ——

const mk = (id, targets) => ({
  id, base_date: '2026-07-28', base_price: 4022.2,
  horizons: {
    short:  { n_sessions: 1,  target_date: targets[0], final: { prob_up: 0.58, low: 3987, high: 4059 }, baseline: { prob_up: 0.53, low: 3978, high: 4067 }, settled: false },
    medium: { n_sessions: 5,  target_date: targets[1], final: { prob_up: 0.55, low: 3922, high: 4124 }, baseline: { prob_up: 0.54, low: 3920, high: 4130 }, settled: false },
    long:   { n_sessions: 20, target_date: targets[2], final: { prob_up: 0.60, low: 3818, high: 4234 }, baseline: { prob_up: 0.58, low: 3810, high: 4240 }, settled: false },
  },
});

const PRICES = { '2026-07-29': 4048.6, '2026-07-30': 4010, '2026-08-04': 4100 };

test('T9: 三个 horizon 各自独立结算,不同步', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const { predictions } = S.settleAll([p], { calendar: CAL, priceByDate: PRICES, today: '2026-08-04' });
  const h = predictions[0].horizons;
  assert.equal(h.short.settled, true, 'short 应已结算');
  assert.equal(h.medium.settled, true, 'medium 应已结算');
  assert.equal(h.long.settled, false, 'long 目标日未到,应仍 pending');
});

test('T10: 记录不含记录级状态字段', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const { predictions } = S.settleAll([p], { calendar: CAL, priceByDate: PRICES, today: '2026-08-04' });
  assert.equal('status' in predictions[0], false, '记录级 status 会掩盖三期不同步');
});

test('T11: 按时结算标 exact', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const { predictions } = S.settleAll([p], { calendar: CAL, priceByDate: PRICES, today: '2026-07-29' });
  assert.equal(predictions[0].horizons.short.settled_kind, 'exact');
  assert.equal(predictions[0].horizons.short.actual, 4048.6);
});

test('T12: 逾期但 30 天内有价,用其后首个定盘价结算并标 approx', () => {
  // 设计 5.3:若逾期只标 stale 不结算,被排除的仍是高不确定日,偏差原样保留。
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  p.horizons.short.target_date = '2026-07-28';       // 目标日无价
  const prices = { '2026-07-30': 4010 };
  const { predictions } = S.settleAll([p], { calendar: CAL, priceByDate: prices, today: '2026-08-05' });
  assert.equal(predictions[0].horizons.short.settled, true, '逾期仍必须结算');
  assert.equal(predictions[0].horizons.short.settled_kind, 'approx');
  assert.equal(predictions[0].horizons.short.settled_date, '2026-07-30');
});

test('T13: 逾期超 30 天标 abandoned', () => {
  const p = mk('2026-07-28', ['2026-06-01', '2026-08-04', '2026-09-01']);
  const { predictions } = S.settleAll([p], { calendar: CAL, priceByDate: {}, today: '2026-08-05' });
  assert.equal(predictions[0].horizons.short.status, 'abandoned');
  assert.equal(predictions[0].horizons.short.settled, false);
});

test('T14: 已结算的 horizon 不被重复改写(幂等)', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const a = S.settleAll([p], { calendar: CAL, priceByDate: PRICES, today: '2026-07-29' });
  const b = S.settleAll(a.predictions, { calendar: CAL, priceByDate: { '2026-07-29': 9999 }, today: '2026-07-29' });
  assert.equal(b.predictions[0].horizons.short.actual, 4048.6, '终态不可被改写');
  assert.equal(b.changed, 0);
});

test('T15: degraded 是正交标记,不进状态枚举', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  p.degraded = true;
  const { predictions } = S.settleAll([p], { calendar: CAL, priceByDate: PRICES, today: '2026-07-29' });
  assert.equal(predictions[0].degraded, true, 'degraded 须原样保留在记录级');
  assert.equal(predictions[0].horizons.short.settled, true, '且不影响结算');
});

test('T16: CLI 就地更新 predictions.json', () => {
  const tmp = freshTmp();
  const pf = path.join(tmp, 'predictions.json');
  const sf = path.join(tmp, 'settlement.json');
  fs.writeFileSync(pf, JSON.stringify({ schema_version: 2, predictions: [mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01'])], skipped_dates: [] }));
  fs.writeFileSync(sf, JSON.stringify({ latest: { date: '2026-07-29', value: 4048.6 }, calendar_tail: CAL,
    history: [{ date: '2026-07-29', value: 4048.6 }] }));
  const r = runCli({ script: 'settle.js', args: ['--predictions', pf, '--settlement', sf, '--today', '2026-07-29'] });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(pf, 'utf-8'));
  assert.equal(out.predictions[0].horizons.short.settled, true);
  fs.rmSync(tmp, { recursive: true, force: true });
  r.cleanup();
});
