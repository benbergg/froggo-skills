'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURE } = require('./helpers');
const em = require('../references/scripts/sources/eastmoney-kline');
const fred = require('../references/scripts/sources/fred-series');
const cot = require('../references/scripts/sources/cftc-cot-current');
const GOLD = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'references', 'instruments', 'gold.json'), 'utf-8'));
const SCHEMA = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'references', 'schemas', 'facts.schema.json'), 'utf-8'));

test('T1: 东财 K 线解析出 OHLCV 与双日期', () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE('eastmoney-kline.raw.json'), 'utf-8'));
  const rows = em.parseKline(raw, 'eastmoney_UDI');
  assert.ok(rows.length > 0);
  const r = rows[rows.length - 1];
  for (const k of ['observed_date', 'available_date', 'vintage']) assert.ok(r[k], `缺 ${k}`);
  for (const k of ['o', 'h', 'l', 'c']) assert.equal(typeof r.value[k], 'number');
  assert.equal(r.available_date, r.observed_date, '日 K 收盘当日即可得');
});

test('T2: FRED 解析记录观测日与可得日,且两者可不同', () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE('fred-DFII10.raw.json'), 'utf-8'));
  const rows = fred.parseObservations(raw, 'fred_DFII10', { availableAt: '2026-07-29' });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.available_date >= r.observed_date), '可得日不得早于观测日');
});

test('T3: FRED 的 "." 缺失值被丢弃', () => {
  const rows = fred.parseObservations(
    { observations: [{ date: '2026-07-01', value: '.' }, { date: '2026-07-02', value: '2.44' }] },
    'fred_X', { availableAt: '2026-07-29' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 2.44);
});

// —— CFTC:四条会计恒等式是格式变更的探测器 ——

test('T4: COT 解析出各群体持仓', () => {
  const text = fs.readFileSync(FIXTURE('cftc-deafut.raw.txt'), 'utf-8');
  const r = cot.parseCot(text);
  assert.equal(typeof r.open_interest, 'number');
  assert.equal(r.net_spec, r.nc_long - r.nc_short);
  assert.equal(r.net_comm, r.comm_long - r.comm_short);
  assert.equal(r.net_nonrep, r.nonrep_long - r.nonrep_short);
});

test('T5: 三个群体净持仓合计为零(零和验证)', () => {
  const r = cot.parseCot(fs.readFileSync(FIXTURE('cftc-deafut.raw.txt'), 'utf-8'));
  assert.equal(r.net_spec + r.net_comm + r.net_nonrep, 0, '零和不成立说明列映射错了');
});

test('T6: 恒等式不成立即抛错,绝不静默解析出错误持仓', () => {
  // 把可报告多头改成一个错值,模拟 CFTC 变更列顺序
  const text = fs.readFileSync(FIXTURE('cftc-deafut.raw.txt'), 'utf-8');
  const parts = text.trim().split(',');
  parts[13] = '  999999';                       // 字段14 可报告多头
  assert.throws(() => cot.parseCot(parts.join(',')), /恒等式/);
});

test('T7: COT 可得日是数据日之后的周五(公布日),不是数据日', () => {
  // 设计 5.6:按数据日对齐等于让模型周二就用上周五才公布的信息。
  assert.equal(cot.cotAvailableDate('2026-07-21'), '2026-07-24');
});

test('T8: COT 可得日容忍数据日本身是周五的情况', () => {
  assert.equal(cot.cotAvailableDate('2026-07-24') > '2026-07-24', true);
});

// —— 配置与契约 ——

test('T9: gold.json 收拢全部品种常数,无字面量遗留', () => {
  for (const k of ['lbma_endpoint', 'cftc_contract_code', 'eastmoney_secids', 'oz_to_gram']) {
    assert.ok(GOLD[k] !== undefined, `gold.json 缺 ${k}`);
  }
  assert.equal(GOLD.cftc_contract_code, '088691');
  assert.ok(Math.abs(GOLD.oz_to_gram - 31.1035) < 1e-6);
});

test('T10: facts schema 每个叶子字段都声明依赖等级', () => {
  const bad = [];
  for (const [name, f] of Object.entries(SCHEMA.fields)) {
    if (!['settlement_hard', 'forecast_hard', 'soft'].includes(f.dependency)) bad.push(name);
  }
  assert.deepEqual(bad, [], `这些字段未声明合法 dependency: ${bad.join(', ')}`);
});

test('T11: schema 中标 traceable 的字段构成 C4 溯源集合', () => {
  const traceable = Object.entries(SCHEMA.fields).filter(([, f]) => f.traceable).map(([k]) => k);
  assert.ok(traceable.length >= 8, 'C4 的可溯源集合过小,溯源会大面积误杀');
});

test('T12: 软依赖字段必须给出 missing_keywords 供 C5 使用', () => {
  const bad = Object.entries(SCHEMA.fields)
    .filter(([, f]) => f.dependency === 'soft' && !Array.isArray(f.missing_keywords))
    .map(([k]) => k);
  assert.deepEqual(bad, [], `软依赖缺 missing_keywords,C5 无从禁论: ${bad.join(', ')}`);
});

test('T13: context_tags 取值域封闭', () => {
  assert.deepEqual(SCHEMA.context_tags.sort(),
    ['crowded_long', 'crowded_short', 'fomc_week', 'high_vol', 'pre_cpi', 'pre_nfp', 'pre_pce', 'stale_cot'].sort());
});
