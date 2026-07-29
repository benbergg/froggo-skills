'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURE, freshTmp } = require('./helpers');
const em = require('../references/scripts/sources/eastmoney-kline');
const fred = require('../references/scripts/sources/fred-series');
const cot = require('../references/scripts/sources/cftc-cot-current');
const cotHistory = require('../references/scripts/sources/cftc-cot-history');
const fredDates = require('../references/scripts/sources/fred-release-dates');
const news = require('../references/scripts/sources/news-search');
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

// —— 评审 Finding 1-4:三个此前零覆盖的适配器补测 ——

test('T14: cot-history 单年失败不影响其他年份,并记入 failed_years', async () => {
  const fetchYearImpl = async (year) => {
    if (year === 2024) throw new Error('network fail');
    return [{ series: 'cftc_gold', observed_date: `${year}-01-02`,
               available_date: `${year}-01-05`, vintage: `${year}-01-05`, value: {} }];
  };
  const r = await cotHistory.fetchSeries({ since: '2023-01-01', until: '2025-01-01' },
    { cacheDir: freshTmp(), fetchYearImpl });
  assert.equal(r.records.length, 2);
  assert.deepEqual(r.failed_years, [2024]);
  assert.equal(r.status, 'ok');
});

test('T15: cot-history 全部年份失败退化为 missing,不抛出', async () => {
  const fetchYearImpl = async () => { throw new Error('network fail'); };
  await assert.doesNotReject(cotHistory.fetchSeries(
    { since: '2023-01-01', until: '2024-01-01' }, { cacheDir: freshTmp(), fetchYearImpl }));
  const r = await cotHistory.fetchSeries({ since: '2023-01-01', until: '2024-01-01' },
    { cacheDir: freshTmp(), fetchYearImpl });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.records, []);
  assert.deepEqual(r.failed_years, [2023, 2024]);
});

test('T16: cot-history 恒等式抛错导致该年被跳过而不是穿透', async () => {
  // 复用 T6 的手法伪造一条列映射错乱的行,让 parseCot 真实抛出恒等式错误。
  const text = fs.readFileSync(FIXTURE('cftc-deafut.raw.txt'), 'utf-8');
  const parts = text.trim().split(',');
  parts[13] = '  999999';
  const badLine = parts.join(',');
  const fetchYearImpl = async (year) => {
    if (year === 2024) { require('../references/scripts/sources/cftc-cot-current').parseCot(badLine); }
    return [];
  };
  const r = await cotHistory.fetchSeries({ since: '2024-01-01', until: '2024-01-01' },
    { cacheDir: freshTmp(), fetchYearImpl });
  assert.deepEqual(r.failed_years, [2024]);
  assert.equal(r.status, 'missing');
});

test('T17: fred-release-dates 全部请求失败时返回 missing,不伪装成健康', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  const r = await fredDates.fetchReleases({ until: '2026-07-29' },
    { releaseIds: { cpi: 10, nfp: 50 }, apiKey: 'x', fetchImpl });
  assert.equal(r.status, 'missing');
});

test('T18: fred-release-dates 部分成功时返回 ok', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => ({ release_dates: [{ date: '2026-08-01' }] }) };
    throw new Error('network down');
  };
  const r = await fredDates.fetchReleases({ until: '2026-07-29' },
    { releaseIds: { cpi: 10, nfp: 50 }, apiKey: 'x', fetchImpl });
  assert.equal(r.status, 'ok');
});

test('T19: news-search 三条返回路径(失败/成功/解析异常)都带 provenance', () => {
  const failImpl = () => ({ status: 1, stdout: '' });
  const r1 = news.fetchNews({ spawnImpl: failImpl });
  assert.equal(r1.status, 'missing');
  assert.ok(r1.provenance && r1.provenance.url && r1.provenance.fetched_at, 'missing 路径缺 provenance');

  const okImpl = () => ({ status: 0, stdout: JSON.stringify({ results: [{ title: 'x', url: 'https://a.com', source: 'A' }] }) });
  const r2 = news.fetchNews({ spawnImpl: okImpl });
  assert.equal(r2.status, 'ok');
  assert.ok(r2.provenance && r2.provenance.url && r2.provenance.fetched_at, 'ok 路径缺 provenance');

  const badJsonImpl = () => ({ status: 0, stdout: 'not json' });
  const r3 = news.fetchNews({ spawnImpl: badJsonImpl });
  assert.equal(r3.status, 'missing');
  assert.ok(r3.provenance && r3.provenance.url && r3.provenance.fetched_at, '解析异常路径缺 provenance');
});

test('T20: news-search normalize 丢弃正文字段,只保留标题/链接/时间/来源', () => {
  const items = [{ title: 't', url: 'https://a.com', body: '大段正文,不该进 records', published_at: '2026-07-01', source: 's' }];
  const out = news.normalize(items);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), ['published_at', 'source', 'title', 'url']);
  assert.equal(out[0].body, undefined);
});
