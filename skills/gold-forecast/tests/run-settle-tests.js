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
  const { predictions } = S.settleAll([p], { priceByDate: PRICES, today: '2026-08-04' });
  const h = predictions[0].horizons;
  assert.equal(h.short.settled, true, 'short 应已结算');
  assert.equal(h.medium.settled, true, 'medium 应已结算');
  assert.equal(h.long.settled, false, 'long 目标日未到,应仍 pending');
});

test('T10: 记录不含记录级状态字段', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const { predictions } = S.settleAll([p], { priceByDate: PRICES, today: '2026-08-04' });
  assert.equal('status' in predictions[0], false, '记录级 status 会掩盖三期不同步');
});

test('T11: 按时结算标 exact', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const { predictions } = S.settleAll([p], { priceByDate: PRICES, today: '2026-07-29' });
  assert.equal(predictions[0].horizons.short.settled_kind, 'exact');
  assert.equal(predictions[0].horizons.short.actual, 4048.6);
});

test('T12: 逾期但 30 天内有价,用其后首个定盘价结算并标 approx', () => {
  // 设计 5.3:若逾期只标 stale 不结算,被排除的仍是高不确定日,偏差原样保留。
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  p.horizons.short.target_date = '2026-07-28';       // 目标日无价
  const prices = { '2026-07-30': 4010 };
  const { predictions } = S.settleAll([p], { priceByDate: prices, today: '2026-08-05' });
  assert.equal(predictions[0].horizons.short.settled, true, '逾期仍必须结算');
  assert.equal(predictions[0].horizons.short.settled_kind, 'approx');
  assert.equal(predictions[0].horizons.short.settled_date, '2026-07-30');
});

test('T13: 逾期超 30 天标 abandoned', () => {
  const p = mk('2026-07-28', ['2026-06-01', '2026-08-04', '2026-09-01']);
  const { predictions } = S.settleAll([p], { priceByDate: {}, today: '2026-08-05' });
  assert.equal(predictions[0].horizons.short.status, 'abandoned');
  assert.equal(predictions[0].horizons.short.settled, false);
});

test('T14: 已结算的 horizon 不被重复改写(幂等)', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const a = S.settleAll([p], { priceByDate: PRICES, today: '2026-07-29' });
  const b = S.settleAll(a.predictions, { priceByDate: { '2026-07-29': 9999 }, today: '2026-07-29' });
  assert.equal(b.predictions[0].horizons.short.actual, 4048.6, '终态不可被改写');
  assert.equal(b.changed, 0);
});

test('T15: degraded 是正交标记,不进状态枚举', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  p.degraded = true;
  const { predictions } = S.settleAll([p], { priceByDate: PRICES, today: '2026-07-29' });
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

// —— C-1:naive 基准须冻结、可追溯,且合法值 0 不得被吞 ——

test('T17: 记录上冻结的 naive_p 优先于 db 级 naiveP', () => {
  // db 级 naive_p 每天被覆盖,T+20 结算时读到的窗口已含被预测行情,等于基准偷看答案
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  p.horizons.short.naive_p = 0.60;
  const { predictions } = S.settleAll([p], { priceByDate: PRICES, today: '2026-07-29', naiveP: { 1: 0.53 } });
  const s = predictions[0].horizons.short.score;
  assert.equal(s.naive_p, 0.60, '须用冻结值而非结算日的 db 值');
  assert.equal(s.naive_p_source, 'frozen');
  assert.ok(Math.abs(s.naive_brier - 0.16) < 1e-9, `上涨样本应为 (1-0.6)^2=0.16,实得 ${s.naive_brier}`);
});

test('T18: naive_p 合法值 0 不得被当成缺失', () => {
  // 原实现用 `||`,0 会被吞成 0.5,基准凭空好转
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const { predictions } = S.settleAll([p], { priceByDate: PRICES, today: '2026-07-29', naiveP: { 1: 0 } });
  const s = predictions[0].horizons.short.score;
  assert.equal(s.naive_p, 0, '0 是合法概率');
  assert.equal(s.naive_p_source, 'db');
  assert.ok(Math.abs(s.naive_brier - 1) < 1e-9, `上涨样本 p=0 时 naive_brier 应为 1,实得 ${s.naive_brier}`);
});

test('T19: 缺该周期键时回退 0.5,且在产物里留痕不静默', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const { predictions, naiveFallback } = S.settleAll([p], { priceByDate: PRICES, today: '2026-07-29', naiveP: { 5: 0.62 } });
  const s = predictions[0].horizons.short.score;
  assert.equal(s.naive_p, 0.5, 'short 无键不得挪用 medium 的值');
  assert.equal(s.naive_p_source, 'fallback', '回退必须可辨识,否则 0.25 分不清来源');
  assert.ok(naiveFallback.includes('2026-07-28/short'), `回退清单应含该 horizon,实得 ${JSON.stringify(naiveFallback)}`);
});

test('T20: 完全无 naiveP 时同样标 fallback 而非伪装成真基准', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const { predictions } = S.settleAll([p], { priceByDate: PRICES, today: '2026-07-29' });
  assert.equal(predictions[0].horizons.short.score.naive_p_source, 'fallback');
  assert.equal(predictions[0].horizons.short.score.naive_p, 0.5);
});

// —— I-2:--today 回放不得用未来价结算 ——

test('T21: today 早于目标日时,即便 priceByDate 已含目标日价也不得结算', () => {
  // 守卫原先排在 exact 分支之后,--today 回放会把三期一次性用未来价结掉
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const prices = { '2026-07-29': 4048.6, '2026-08-04': 4100, '2026-09-01': 4200 };
  const { predictions, changed } = S.settleAll([p], { priceByDate: prices, today: '2026-07-01' });
  const h = predictions[0].horizons;
  assert.equal(changed, 0, '回放日之后的价一条都不该被采信');
  assert.equal(h.short.settled, false);
  assert.equal(h.medium.settled, false);
  assert.equal(h.long.settled, false);
});

test('T22: 逾期补价也不得越过 today 取未来价', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  p.horizons.short.target_date = '2026-07-20';        // 目标日无价,已逾期
  const { predictions } = S.settleAll([p], { priceByDate: { '2026-07-29': 4048.6 }, today: '2026-07-25' });
  assert.equal(predictions[0].horizons.short.settled, false, 'approx 只能用 today 及以前的价');
});

test('T23: 目标日当天有价仍按 exact 结算(守卫前移不得误杀)', () => {
  const p = mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01']);
  const { predictions } = S.settleAll([p], { priceByDate: PRICES, today: '2026-07-29' });
  assert.equal(predictions[0].horizons.short.settled_kind, 'exact');
});

// —— 现状锁定:以下行为本身是对的,补测试防回归 ——

test('T24: prob_up 恰为 0.5 判跌(非对称,与 scorecard naive 口径共用)', () => {
  const up = S.scoreOne({ prob_up: 0.5, low: 3900, high: 4100, base_price: 4022.2, actual: 4030, naive_p: 0.5 });
  assert.equal(up.dir_correct, false, '0.5 不算看涨,实际涨则判错');
  const down = S.scoreOne({ prob_up: 0.5, low: 3900, high: 4100, base_price: 4022.2, actual: 4010, naive_p: 0.5 });
  assert.equal(down.dir_correct, true);
});

test('T25: in_range 端点计为命中(闭区间)', () => {
  const lo = S.scoreOne({ prob_up: 0.58, low: 3987, high: 4059, base_price: 4022.2, actual: 3987, naive_p: 0.5 });
  const hi = S.scoreOne({ prob_up: 0.58, low: 3987, high: 4059, base_price: 4022.2, actual: 4059, naive_p: 0.5 });
  assert.equal(lo.in_range, true);
  assert.equal(hi.in_range, true);
  assert.ok(Math.abs(lo.winkler - 72) < 1e-9, '端点不触发罚项');
  assert.ok(Math.abs(hi.winkler - 72) < 1e-9);
});

test('T26: CLI 回退 0.5 时 stderr 出警告', () => {
  const tmp = freshTmp();
  const pf = path.join(tmp, 'predictions.json');
  const sf = path.join(tmp, 'settlement.json');
  fs.writeFileSync(pf, JSON.stringify({ schema_version: 2, predictions: [mk('2026-07-28', ['2026-07-29', '2026-08-04', '2026-09-01'])], skipped_dates: [] }));
  fs.writeFileSync(sf, JSON.stringify({ latest: { date: '2026-07-29', value: 4048.6 }, calendar_tail: CAL,
    history: [{ date: '2026-07-29', value: 4048.6 }] }));
  const r = runCli({ script: 'settle.js', args: ['--predictions', pf, '--settlement', sf, '--today', '2026-07-29'] });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(/回退 0\.5/.test(r.stderr), `应告警基准回退,实得 stderr: ${r.stderr}`);
  const out = JSON.parse(fs.readFileSync(pf, 'utf-8'));
  assert.equal(out.predictions[0].horizons.short.score.naive_p_source, 'fallback');
  fs.rmSync(tmp, { recursive: true, force: true });
  r.cleanup();
});
