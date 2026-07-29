'use strict';
// --fixture-dir 约定(存在时不联网): lbma.raw.json / fred-<ID>.raw.json /
// eastmoney-<secid后缀>.raw.json / cftc-current.raw.txt /
// fred-releases.json / news.json;文件缺失即该字段 missing。
const fs = require('node:fs');
const path = require('node:path');
const { HistoryStore } = require('./lib/history-store');
const { atomicWriteJSON } = require('./lib/atomic-write');
const { parseLbma, fetchSeries: fetchLbma } = require('./sources/lbma-gold-pm');
const { parseKline, fetchSeries: fetchEastmoney } = require('./sources/eastmoney-kline');
const { parseObservations, fetchSeries: fetchFred } = require('./sources/fred-series');
const { fetchReleases } = require('./sources/fred-release-dates');
const { parseCot, cotAvailableDate, fetchSeries: fetchCftcCurrent } = require('./sources/cftc-cot-current');
const { fetchSeries: fetchCftcHistory } = require('./sources/cftc-cot-history');
const { normalize: normalizeNews, fetchNews } = require('./sources/news-search');

const CROWDED_HI = 0.85;
const CROWDED_LO = 0.15;
const HIGH_VOL_PCTILE = 0.8;
const STALE_COT_DAYS = 10;
const SIGMA_WINDOW = 20;
const SIGMA_ROLLING_MIN = 20;
const SIGMA_LOOKBACK = 250;
const CFTC_HISTORY_MIN_ROWS = 100;
const CFTC_HISTORY_YEARS = 3;
const CFTC_PCTILE_MIN_SAMPLES = 20;

function classify(statusByField, schema) {
  const missing = [];
  const forecastHardMissing = [];
  for (const [field, st] of Object.entries(statusByField)) {
    if (st === 'ok') continue;
    missing.push(field);
    const spec = schema.fields[field];
    if (spec && spec.dependency === 'forecast_hard') forecastHardMissing.push(field);
  }
  return { missing, forecastHardMissing };
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// 标签必须由脚本机械推导:若交给模型自选,它就能改标签来避开
// 那些指出自身系统性缺陷的教训。
function deriveContextTags(facts, { sigmaPctile } = {}) {
  const tags = [];
  const rel = (facts.calendar && facts.calendar.next_releases) || {};
  const near = [facts.target_date, facts.prev_session].filter(Boolean);
  const hits = (dates) => (dates || []).some((d) => near.includes(d) || near.some((n) => daysBetween(n, d) === 1));
  if (hits(rel.cpi)) tags.push('pre_cpi');
  if (hits(rel.nfp)) tags.push('pre_nfp');
  if (hits(rel.pce)) tags.push('pre_pce');
  if (rel.fomc && rel.fomc.length && facts.target_date
      && rel.fomc.some((d) => Math.abs(daysBetween(facts.target_date, d)) <= 3)) tags.push('fomc_week');

  const c = facts.cftc || {};
  if (typeof c.spec_pctile === 'number') {
    if (c.spec_pctile >= CROWDED_HI) tags.push('crowded_long');
    if (c.spec_pctile <= CROWDED_LO) tags.push('crowded_short');
  }
  if (c.available_date && facts.target_date
      && daysBetween(c.available_date, facts.target_date) > STALE_COT_DAYS) tags.push('stale_cot');
  if (typeof sigmaPctile === 'number' && sigmaPctile >= HIGH_VOL_PCTILE) tags.push('high_vol');
  return tags;
}

// 先写 history 再写 facts;facts 失败即按主键回滚,避免建模源与快照分叉。
function writeWithRollback({ historyDir, factsPath, appended, facts }) {
  const store = new HistoryStore(historyDir);
  const written = [];
  for (const [series, records] of Object.entries(appended)) {
    store.upsert(series, records);
    written.push([series, records.map((r) => ({ observed_date: r.observed_date, vintage: r.vintage }))]);
  }
  try {
    atomicWriteJSON(factsPath, facts);
  } catch (e) {
    for (const [series, keys] of written) store.remove(series, keys);
    throw e;
  }
}

// —— 统计小工具:sigma 分位与 CFTC 持仓分位共用同一套 percentile-rank ——

function stdev(arr) {
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length);
}

function percentileRank(series, current) {
  if (typeof current !== 'number' || series.length === 0) return undefined;
  return series.filter((v) => v <= current).length / series.length;
}

// upsert 的只读版本,用于在真正落盘前预览「若此刻写入 history/ 会是什么样」。
function mergeRecords(existing, fresh) {
  const key = (r) => `${r.observed_date}|${r.vintage}`;
  const map = new Map(existing.map((r) => [key(r), r]));
  for (const r of fresh) map.set(key(r), { ...map.get(key(r)), ...r });
  return [...map.values()].sort((a, b) => (a.observed_date < b.observed_date ? -1 : a.observed_date > b.observed_date ? 1 : 0));
}

function computePrevSession(records, targetDate) {
  const before = records.map((r) => r.observed_date).filter((d) => d < targetDate);
  return before.length ? before[before.length - 1] : null;
}

// 历史不足时宁可 undefined 也不给假分位(不用 ATR,见设计 5.0)。
function computeSigmaPctile(records) {
  const prices = records.map((r) => r.value).filter((v) => typeof v === 'number');
  if (prices.length < SIGMA_WINDOW + 1) return undefined;
  const returns = [];
  for (let i = 1; i < prices.length; i++) returns.push(Math.log(prices[i] / prices[i - 1]));
  const rolling = [];
  for (let end = SIGMA_WINDOW; end <= returns.length; end++) rolling.push(stdev(returns.slice(end - SIGMA_WINDOW, end)));
  if (rolling.length < SIGMA_ROLLING_MIN) return undefined;
  const recent = rolling.slice(-SIGMA_LOOKBACK);
  return percentileRank(recent, recent[recent.length - 1]);
}

// —— --fixture-dir / 联网 双模加载器:每个返回统一的 {records, status} ——

function readFixtureJSON(fixtureDir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf-8')); } catch { return null; }
}

function readFixtureText(fixtureDir, name) {
  try { return fs.readFileSync(path.join(fixtureDir, name), 'utf-8'); } catch { return null; }
}

async function loadLbma({ fixtureDir }) {
  if (fixtureDir) {
    const raw = readFixtureJSON(fixtureDir, 'lbma.raw.json');
    if (!raw) return { records: [], status: 'missing' };
    try {
      const records = parseLbma(raw);
      return { records, status: records.length ? 'ok' : 'missing' };
    } catch (e) { console.error(`LBMA 采集失败: ${e.message}`); return { records: [], status: 'missing' }; }
  }
  try { return await fetchLbma({}); } catch (e) { console.error(`LBMA 采集失败: ${e.message}`); return { records: [], status: 'missing' }; }
}

async function loadFred({ fixtureDir, id, today, apiKey }) {
  const series = `fred_${id}`;
  if (fixtureDir) {
    const raw = readFixtureJSON(fixtureDir, `fred-${id}.raw.json`);
    if (!raw) return { records: [], status: 'missing' };
    try {
      const records = parseObservations(raw, series, { availableAt: today });
      return { records, status: records.length ? 'ok' : 'missing' };
    } catch (e) { console.error(`FRED ${id} 采集失败: ${e.message}`); return { records: [], status: 'missing' }; }
  }
  try { return await fetchFred({ mode: 'default', until: today }, { seriesId: id, series, apiKey }); }
  catch (e) { console.error(`FRED ${id} 采集失败: ${e.message}`); return { records: [], status: 'missing' }; }
}

async function loadEastmoney({ fixtureDir, key, secid, suffix, today }) {
  if (fixtureDir) {
    const raw = readFixtureJSON(fixtureDir, `eastmoney-${suffix}.raw.json`);
    if (!raw) return { records: [], status: 'missing' };
    try {
      const records = parseKline(raw, key);
      return { records, status: records.length ? 'ok' : 'missing' };
    } catch (e) { console.error(`东财 ${suffix} 采集失败: ${e.message}`); return { records: [], status: 'missing' }; }
  }
  try { return await fetchEastmoney({ mode: 'incremental', until: today }, { secid, series: key }); }
  catch (e) { console.error(`东财 ${suffix} 采集失败: ${e.message}`); return { records: [], status: 'missing' }; }
}

async function loadCftcCurrent({ fixtureDir }) {
  if (fixtureDir) {
    const text = readFixtureText(fixtureDir, 'cftc-current.raw.txt');
    if (!text) return { records: [], status: 'missing' };
    try {
      const r = parseCot(text);
      const avail = cotAvailableDate(r.observed_date);
      return { records: [{ series: 'cftc_gold', observed_date: r.observed_date, available_date: avail, vintage: avail, value: r }], status: 'ok' };
    } catch (e) { console.error(`CFTC 当期解析失败: ${e.message}`); return { records: [], status: 'missing' }; }
  }
  try { return await fetchCftcCurrent({}, {}); } catch (e) { console.error(`CFTC 当期采集失败: ${e.message}`); return { records: [], status: 'missing' }; }
}

async function loadCalendar({ fixtureDir, releaseIds, today, apiKey }) {
  if (fixtureDir) {
    const raw = readFixtureJSON(fixtureDir, 'fred-releases.json');
    if (!raw) return { records: { cpi: [], nfp: [], pce: [] }, status: 'missing' };
    try {
      // fred-releases.json 直接是结构化数据,不需要额外解析
      return { records: raw, status: 'ok' };
    } catch (e) { console.error(`FRED 发布日历采集失败: ${e.message}`); return { records: { cpi: [], nfp: [], pce: [] }, status: 'missing' }; }
  }
  try { return await fetchReleases({ until: today }, { releaseIds, apiKey }); }
  catch (e) { console.error(`FRED 发布日历采集失败: ${e.message}`); return { records: { cpi: [], nfp: [], pce: [] }, status: 'missing' }; }
}

async function loadNews({ fixtureDir }) {
  if (fixtureDir) {
    const raw = readFixtureJSON(fixtureDir, 'news.json');
    if (!raw) return { records: [], status: 'missing' };
    try {
      return { records: normalizeNews(raw), status: 'ok' };
    } catch (e) { console.error(`新闻采集失败: ${e.message}`); return { records: [], status: 'missing' }; }
  }
  try { return await fetchNews({}); } catch (e) { console.error(`新闻采集失败: ${e.message}`); return { records: [], status: 'missing' }; }
}

// 持仓分位只从 history/ 累积算,不足时一次性拉 zip 回补(设计 5.7.3)。
async function computeCftcSpecPctile({ store, fixtureDir, currentRecord, today }) {
  const existing = store.read('cftc_gold');
  let backfill = [];
  if (!fixtureDir && existing.length < CFTC_HISTORY_MIN_ROWS) {
    const since = `${Number(today.slice(0, 4)) - CFTC_HISTORY_YEARS}-01-01`;
    const cacheDir = path.join(store.root, '.cftc-year-cache');
    try { backfill = (await fetchCftcHistory({ since, until: today }, { cacheDir })).records; }
    catch (e) { console.error(`CFTC 历史回补失败: ${e.message}`); backfill = []; }
  }
  const merged = mergeRecords(mergeRecords(existing, backfill), currentRecord ? [currentRecord] : []);
  const netSpecSeries = merged.map((r) => r.value && r.value.net_spec).filter((v) => typeof v === 'number');
  const current = currentRecord && currentRecord.value ? currentRecord.value.net_spec : undefined;
  // 样本太少时分位必然贴 0/1(单点即 100 分位),没有统计意义。
  if (netSpecSeries.length < CFTC_PCTILE_MIN_SAMPLES) return { pctile: undefined, backfill };
  return { pctile: percentileRank(netSpecSeries, current), backfill };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out || !args.history || !args.today) {
    console.error('缺少必需参数: --out --history --today');
    process.exit(1);
    return;
  }
  const today = args.today;
  const fixtureDir = args['fixture-dir'] ? path.resolve(args['fixture-dir']) : null;
  const historyDir = path.resolve(args.history);
  const factsPath = path.resolve(args.out);
  const fredApiKey = process.env.FRED_API_KEY;

  const gold = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'instruments', 'gold.json'), 'utf-8'));
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'facts.schema.json'), 'utf-8'));

  const statusByField = {};
  for (const f of Object.keys(schema.fields)) statusByField[f] = 'missing';
  const fieldRecords = {};
  const appended = {};

  // —— Phase A:纯读取/联网,不碰 HistoryStore ——

  const lbma = await loadLbma({ fixtureDir });
  statusByField['lbma.pm_usd'] = lbma.status;
  if (lbma.records.length) {
    appended.lbma_pm_usd = lbma.records;
    fieldRecords['lbma.pm_usd'] = lbma.records[lbma.records.length - 1];
  }

  for (const id of gold.fred_series) {
    const series = `fred_${id}`;
    const field = `fred.${id}`;
    const r = await loadFred({ fixtureDir, id, today, apiKey: fredApiKey });
    if (r.records.length) appended[series] = r.records;
    if (Object.prototype.hasOwnProperty.call(schema.fields, field)) {
      statusByField[field] = r.status;
      if (r.records.length) fieldRecords[field] = r.records[r.records.length - 1];
    }
  }

  for (const [key, secid] of Object.entries(gold.eastmoney_secids)) {
    const suffix = key.replace(/^eastmoney_/, '');
    const field = `eastmoney.${suffix}`;
    const r = await loadEastmoney({ fixtureDir, key, secid, suffix, today });
    if (r.records.length) appended[key] = r.records;
    if (Object.prototype.hasOwnProperty.call(schema.fields, field)) {
      statusByField[field] = r.status;
      if (r.records.length) fieldRecords[field] = r.records[r.records.length - 1];
    }
  }

  const cot = await loadCftcCurrent({ fixtureDir });
  const cotLatest = cot.records[cot.records.length - 1] || null;
  statusByField['cftc.net_spec'] = cot.status;
  statusByField['cftc.net_comm'] = cot.status;
  if (cotLatest) {
    fieldRecords['cftc.net_spec'] = { value: cotLatest.value.net_spec, observed_date: cotLatest.observed_date, available_date: cotLatest.available_date };
    fieldRecords['cftc.net_comm'] = { value: cotLatest.value.net_comm, observed_date: cotLatest.observed_date, available_date: cotLatest.available_date };
  }

  const cal = await loadCalendar({ fixtureDir, releaseIds: gold.fred_release_ids, today, apiKey: fredApiKey });
  statusByField['calendar.next_releases'] = cal.status;

  const news = await loadNews({ fixtureDir });
  statusByField['news.items'] = news.status;

  // —— 硬依赖闸门:必须在任何 HistoryStore 侧写之前完成,否则 exit(3) 也会留下半截产物 ——

  const gate = classify(statusByField, schema);
  if (gate.forecastHardMissing.length) {
    console.error(`预测硬依赖缺失,不写任何产物: ${gate.forecastHardMissing.join(', ')}`);
    process.exit(3);
    return;
  }

  // —— Phase B:通过闸门后才允许接触 HistoryStore ——

  const store = new HistoryStore(historyDir);
  const existingLbma = store.read('lbma_pm_usd');
  const mergedLbma = mergeRecords(existingLbma, lbma.records);
  const prevSession = computePrevSession(mergedLbma, today);
  const sigmaPctile = computeSigmaPctile(mergedLbma);

  const { pctile: specPctile, backfill } = await computeCftcSpecPctile({ store, fixtureDir, currentRecord: cotLatest, today });
  if (backfill.length) appended.cftc_gold = mergeRecords(cot.records, backfill);
  else if (cot.records.length) appended.cftc_gold = cot.records;
  statusByField['cftc.spec_pctile'] = typeof specPctile === 'number' ? 'ok' : 'missing';
  if (typeof specPctile === 'number' && cotLatest) {
    fieldRecords['cftc.spec_pctile'] = { value: specPctile, observed_date: cotLatest.observed_date, available_date: cotLatest.available_date };
  }

  const factsCore = {
    target_date: today,
    prev_session: prevSession,
    cftc: {
      net_spec: cotLatest ? cotLatest.value.net_spec : null,
      net_comm: cotLatest ? cotLatest.value.net_comm : null,
      spec_pctile: typeof specPctile === 'number' ? specPctile : null,
      available_date: cotLatest ? cotLatest.available_date : null,
    },
    calendar: { next_releases: cal.records },
  };
  const contextTags = deriveContextTags(factsCore, { sigmaPctile });

  const fields = {};
  for (const field of Object.keys(schema.fields)) {
    const rec = fieldRecords[field];
    fields[field] = {
      status: statusByField[field],
      value: rec ? rec.value : null,
      observed_date: rec ? rec.observed_date : null,
      available_date: rec ? rec.available_date : null,
    };
  }

  const { missing } = classify(statusByField, schema);
  const facts = {
    schema_version: schema.schema_version,
    generated_at: new Date().toISOString(),
    target_date: today,
    prev_session: prevSession,
    context_tags: contextTags,
    sigma_pctile: typeof sigmaPctile === 'number' ? sigmaPctile : null,
    fields,
    cftc: factsCore.cftc,
    calendar: factsCore.calendar,
    news: { items: news.records, status: news.status },
    _missing: missing,
  };

  writeWithRollback({ historyDir, factsPath, appended, facts });
  console.error(`facts 采集完成: ${Object.keys(fields).length} 字段, missing=${missing.length}, tags=${contextTags.join(',') || '无'}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { classify, deriveContextTags, writeWithRollback };
