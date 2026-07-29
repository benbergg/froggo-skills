'use strict';
const BASE = 'https://api.stlouisfed.org/fred/release/dates';

async function fetchReleases(range, { releaseIds, apiKey, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const out = {};
  const errors = {};                              // 逐 release 失败原因,nfp:[] 不再等于"这周确实没有发布"
  let anyOk = false;                              // 全部请求失败时不得伪装成健康的 'ok'
  for (const [name, id] of Object.entries(releaseIds)) {
    const p = new URLSearchParams({ release_id: String(id), realtime_start: range.until,
      include_release_dates_with_no_data: 'true', sort_order: 'asc', limit: '6',
      file_type: 'json', api_key: apiKey });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${BASE}?${p}`, { signal: ctrl.signal });
      if (res.ok) { out[name] = ((await res.json()).release_dates || []).map((r) => r.date); anyOk = true; }
      else { out[name] = []; errors[name] = `HTTP ${res.status}`; }
    } catch (e) { out[name] = []; errors[name] = e.message; } finally { clearTimeout(timer); }
  }
  return { records: out, status: anyOk ? 'ok' : 'missing', errors,
           provenance: { url: BASE, fetched_at: new Date().toISOString() } };
}

module.exports = { fetchReleases };
