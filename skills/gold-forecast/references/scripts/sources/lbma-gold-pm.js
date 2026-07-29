'use strict';

const ENDPOINT = 'https://prices.lbma.org.uk/json/gold_pm.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';

// 定盘价当日公布,无发布滞后,故 observed/available/vintage 三者同日。
function parseLbma(raw) {
  const out = [];
  for (const row of raw) {
    const usd = row && Array.isArray(row.v) ? row.v[0] : null;
    if (usd === null || usd === undefined || !row.d) continue;
    out.push({ observed_date: row.d, available_date: row.d, vintage: row.d, value: usd });
  }
  out.sort((a, b) => (a.observed_date < b.observed_date ? -1 : 1));
  return out;
}

async function fetchRaw({ timeoutMs = 30_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`LBMA HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSeries(opts) {
  return { records: parseLbma(await fetchRaw(opts)), status: 'ok', provenance: { url: ENDPOINT, fetched_at: new Date().toISOString() } };
}

module.exports = { parseLbma, fetchRaw, fetchSeries, ENDPOINT };
