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

async function fetchSeries(range, { seriesId, series, apiKey, timeoutMs = 30_000 } = {}) {
  const url = buildUrl(seriesId, range, apiKey);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { records: [], status: 'missing', provenance: { url: BASE, fetched_at: new Date().toISOString() } };
    const raw = await res.json();
    return { records: parseObservations(raw, series, { availableAt: range.until }), status: 'ok',
             provenance: { url: BASE, fetched_at: new Date().toISOString() } };
  } catch {
    return { records: [], status: 'missing', provenance: { url: BASE, fetched_at: new Date().toISOString() } };
  } finally { clearTimeout(timer); }
}

module.exports = { parseObservations, buildUrl, fetchSeries };
