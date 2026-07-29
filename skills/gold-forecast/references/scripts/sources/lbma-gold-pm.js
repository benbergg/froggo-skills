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

// fetchImpl 可注入,测试借此模拟 200-空数组/HTTP 失败,不必发真实请求。
async function fetchRaw({ timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(ENDPOINT, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`LBMA HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSeries(opts) {
  const records = parseLbma(await fetchRaw(opts));
  // 200 但空数组不等于「今天确实没有新数据」,status 必须由 records 长度驱动。
  return { records, status: records.length ? 'ok' : 'missing', provenance: { url: ENDPOINT, fetched_at: new Date().toISOString() } };
}

module.exports = { parseLbma, fetchRaw, fetchSeries, ENDPOINT };
