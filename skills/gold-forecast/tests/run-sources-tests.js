'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURE, freshTmp } = require('./helpers');
const em = require('../references/scripts/sources/eastmoney-kline');
const fred = require('../references/scripts/sources/fred-series');
const cot = require('../references/scripts/sources/cftc-cot-current');
const cotHistory = require('../references/scripts/sources/cftc-cot-history');
const fredDates = require('../references/scripts/sources/fred-release-dates');
const news = require('../references/scripts/sources/news-search');
const lbma = require('../references/scripts/sources/lbma-gold-pm');
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

// —— A1:200 但空数组/结构变了不得仍标 'ok'(四个适配器同型修复) ——

test('T21: fred-series 实时抓取 200 但 observations 为空数组时 status 为 missing', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ observations: [] }) });
  const r = await fred.fetchSeries({ mode: 'default', until: '2026-07-29' },
    { seriesId: 'DFII10', series: 'fred_DFII10', apiKey: 'secret-key', fetchImpl });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.records, []);
});

test('T22: fred-series HTTP 非 200 时 error 字段带状态码,且 provenance.url 不含 query(不泄漏 key)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  const r = await fred.fetchSeries({ mode: 'default', until: '2026-07-29' },
    { seriesId: 'DFII10', series: 'fred_DFII10', apiKey: 'secret-key', fetchImpl });
  assert.equal(r.status, 'missing');
  assert.equal(r.error, 'HTTP 403');
  assert.ok(!r.provenance.url.includes('secret-key'), 'provenance.url 不得携带 query,更不能泄漏 key');
  assert.ok(!r.provenance.url.includes('?'), 'provenance.url 必须只记不含 query 的 BASE');
});

test('T23: fred-series 抓取抛异常时 error 为 e.message 且不含 apiKey', async () => {
  const fetchImpl = async () => { throw new Error('network timeout'); };
  const r = await fred.fetchSeries({ mode: 'default', until: '2026-07-29' },
    { seriesId: 'DFII10', series: 'fred_DFII10', apiKey: 'secret-key', fetchImpl });
  assert.equal(r.status, 'missing');
  assert.equal(r.error, 'network timeout');
});

test('T24: 东财 K 线实时抓取 200 但 data.klines 缺失时 status 为 missing', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ rc: 0, data: {} }) });
  const r = await em.fetchSeries({ mode: 'incremental', until: '2026-07-29' },
    { secid: '100.UDI', series: 'eastmoney_UDI', fetchImpl });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.records, []);
});

test('T25: 东财 K 线 HTTP 非 200 时记录 error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const r = await em.fetchSeries({ mode: 'incremental', until: '2026-07-29' },
    { secid: '100.UDI', series: 'eastmoney_UDI', fetchImpl });
  assert.equal(r.status, 'missing');
  assert.equal(r.error, 'HTTP 500');
});

test('T26: LBMA 实时抓取 200 但空数组时 status 为 missing', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  const r = await lbma.fetchSeries({ fetchImpl });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.records, []);
});

test('T27: news-search 有效 JSON 但 results 为空数组时 status 为 missing', () => {
  const okEmptyImpl = () => ({ status: 0, stdout: JSON.stringify({ results: [] }) });
  const r = news.fetchNews({ spawnImpl: okEmptyImpl });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.records, []);
});

// —— A5:cot-history 真实 fetchYear 对 HTTP 失败/解压异常必须抛错,不能静默返回 [] ——

test('T28: cot-history 真实 fetchYear 对 HTTP 失败抛错(而非返回空数组)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    cotHistory.fetchYear(2099, freshTmp(), { fetchImpl }),
    /HTTP 503/,
  );
});

test('T29: cot-history 真实 fetchYear 解压后找不到 txt 时抛错(而非返回空数组)', async () => {
  // 预置一个非法 zip,跳过网络路径直接进入解压分支;真实 unzip 对非法内容会失败,readdir 拿不到 txt。
  const cacheDir = freshTmp();
  fs.writeFileSync(path.join(cacheDir, 'deacot2098.zip'), 'not a real zip');
  await assert.rejects(
    cotHistory.fetchYear(2098, cacheDir, {}),
    /未找到 txt/,
  );
});

test('T30: cot-history fetchSeries 用真实 fetchYear 时,HTTP 失败年份被正确记入 failed_years', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('2097')) return { ok: false, status: 503 };
    throw new Error('不该请求到这一年');
  };
  const r = await cotHistory.fetchSeries({ since: '2097-01-01', until: '2097-01-01' },
    { cacheDir: freshTmp(), fetchYearImpl: (y, dir) => cotHistory.fetchYear(y, dir, { fetchImpl }) });
  assert.deepEqual(r.failed_years, [2097]);
  assert.equal(r.status, 'missing');
});

// —— A7:fred-release-dates 逐 release 失败原因不得被 nfp:[] 吞掉 ——

test('T31: fred-release-dates errors 字段记录逐 release 失败原因', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('release_id=50')) return { ok: false, status: 403 };
    return { ok: true, json: async () => ({ release_dates: [{ date: '2026-08-01' }] }) };
  };
  const r = await fredDates.fetchReleases({ until: '2026-07-29' },
    { releaseIds: { cpi: 10, nfp: 50 }, apiKey: 'x', fetchImpl });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.records.nfp, [], 'nfp 失败时 records.nfp 仍是空数组');
  assert.equal(r.errors.nfp, 'HTTP 403', 'nfp:[] 必须能在 errors 里查到失败原因,不能与"这周确实没有发布"同形');
  assert.equal(r.errors.cpi, undefined, '成功的 release 不应出现在 errors 里');
});

// —— MF-1:FRED 响应形态不符必须响亮失败,而不是产出 NaN ——

test('T32: 宽表响应(output_type=2/3 形态)喂进 parseObservations 必须抛错', () => {
  const wide = JSON.parse(fs.readFileSync(FIXTURE('fred-DFII10.widetable.raw.json'), 'utf-8'));
  // 宽表的列名是动态拼出的 DFII10_YYYYMMDD,没有 value 键 ⇒ Number(undefined)=NaN。
  // 产出 NaN 会落盘成 value:null 而 status 仍是 'ok',整库被静默毁掉且全程 exit 0。
  assert.throws(() => fred.parseObservations(wide, 'fred_DFII10', { availableAt: '2026-07-28' }),
    /形态异常/, '宽表必须抛错而不是产出 NaN');
});

test('T33: 单条观测值无法解析成有限数即抛错(不区分缺键与垃圾值)', () => {
  for (const bad of [{ date: '2026-07-02' }, { date: '2026-07-02', value: 'N/A' },
    { date: '2026-07-02', value: '' }, { value: '2.44' }]) {
    assert.throws(() => fred.parseObservations({ observations: [bad] }, 'fred_X', { availableAt: '2026-07-29' }),
      /形态异常/, `应抛错: ${JSON.stringify(bad)}`);
  }
});

test('T34: 逐 (date, vintage) 行响应解析出多个不同 available_date', () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE('fred-DFII10.vintages.raw.json'), 'utf-8'));
  const rows = fred.parseObservations(raw, 'fred_DFII10', { availableAt: '2026-07-28' });
  assert.equal(rows.length, 4, '"." 行被丢弃,其余 4 行须全部解析出来');
  for (const r of rows) assert.ok(Number.isFinite(r.value), JSON.stringify(r));
  assert.ok(new Set(rows.map((r) => r.available_date)).size > 1,
    'available_date 全相等 = vintage 信息丢失,回测期间 FRED 行会全程不可见');
  // 同一观测日的两个版本必须都留下来,否则修订历史被压平
  const jun17 = rows.filter((r) => r.observed_date === '2026-06-17');
  assert.equal(jun17.length, 2);
  assert.deepEqual(jun17.map((r) => r.value).sort(), [2.23, 2.25]);
});

test('T35: vintages 回填被分页截断时不得报 ok', async () => {
  const raw = JSON.parse(fs.readFileSync(FIXTURE('fred-DFII10.vintages.raw.json'), 'utf-8'));
  const truncated = { ...raw, count: 9000, observations: raw.observations.slice(0, 3) };
  const fetchImpl = async () => ({ ok: true, json: async () => truncated });
  const r = await fred.fetchSeries({ mode: 'vintages', since: '2021-07-01', until: '2026-07-28' },
    { seriesId: 'DFII10', series: 'fred_DFII10', apiKey: 'secret-key', fetchImpl });
  assert.equal(r.status, 'missing');
  assert.match(r.error, /截断/);
  assert.ok(!r.error.includes('secret-key'));
});

test('T36: 完整响应里的 "." 缺失值不得被误判成分页截断', () => {
  // count 计的是 observations 行数,records 已剔除 "." ——拿 records 去比会把每个假期都判成丢页
  const raw = JSON.parse(fs.readFileSync(FIXTURE('fred-DFII10.vintages.raw.json'), 'utf-8'));
  assert.ok(raw.observations.some((o) => o.value === '.'), '夹具须含 "." 行,否则这条测不到');
  assert.equal(raw.count, raw.observations.length);
});
