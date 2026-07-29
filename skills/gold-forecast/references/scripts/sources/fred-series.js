'use strict';
const BASE = 'https://api.stlouisfed.org/fred/series/observations';

function parseObservations(raw, series, { availableAt }) {
  return (raw.observations || [])
    .filter((o) => o.value !== '.')
    .map((o) => ({ series, observed_date: o.date,
                   // 观测日与可得日不同 —— 实测 DTWEXBGS 滞后达 5 天。
                   available_date: o.realtime_start && o.realtime_start > o.date ? o.realtime_start : availableAt,
                   vintage: o.realtime_start || availableAt, value: Number(o.value) }))
    .sort((a, b) => (a.observed_date < b.observed_date ? -1 : 1));
}

// mode='vintages' 用 output_type=2 一次取回全部历史版本:
// 朴素做法是每天一次 realtime 查询,4 序列 x 5 年 x 250 天约 5000 次请求,必然触限。
function buildUrl(seriesId, range, apiKey) {
  const p = new URLSearchParams({ series_id: seriesId, file_type: 'json', api_key: apiKey });
  if (range.mode === 'vintages') { p.set('output_type', '2'); if (range.since) p.set('realtime_start', range.since); p.set('realtime_end', range.until); }
  else { p.set('sort_order', 'desc'); p.set('limit', '120'); }
  return `${BASE}?${p}`;
}

// fetchImpl 可注入,测试借此模拟 200-空数组/结构畸形/HTTP 失败,不必发真实请求。
async function fetchSeries(range, { seriesId, series, apiKey, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const url = buildUrl(seriesId, range, apiKey);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) {
      return { records: [], status: 'missing', error: `HTTP ${res.status}`,
               provenance: { url: BASE, fetched_at: new Date().toISOString() } };
    }
    const raw = await res.json();
    const records = parseObservations(raw, series, { availableAt: range.until });
    // 200 但空数组/结构变了不等于「今天确实没有新数据」,status 必须跟着 records 走(与 fixture 分支同规则)。
    return { records, status: records.length ? 'ok' : 'missing',
             provenance: { url: BASE, fetched_at: new Date().toISOString() } };
  } catch (e) {
    return { records: [], status: 'missing', error: e.message,
             provenance: { url: BASE, fetched_at: new Date().toISOString() } };
  } finally { clearTimeout(timer); }
}

module.exports = { parseObservations, buildUrl, fetchSeries };
