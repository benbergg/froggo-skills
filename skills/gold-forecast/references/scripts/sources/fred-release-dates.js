'use strict';
const BASE = 'https://api.stlouisfed.org/fred/release/dates';

async function fetchReleases(range, { releaseIds, apiKey, timeoutMs = 30_000 } = {}) {
  const out = {};
  for (const [name, id] of Object.entries(releaseIds)) {
    const p = new URLSearchParams({ release_id: String(id), realtime_start: range.until,
      include_release_dates_with_no_data: 'true', sort_order: 'asc', limit: '6',
      file_type: 'json', api_key: apiKey });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}?${p}`, { signal: ctrl.signal });
      out[name] = res.ok ? ((await res.json()).release_dates || []).map((r) => r.date) : [];
    } catch { out[name] = []; } finally { clearTimeout(timer); }
  }
  return { records: out, status: 'ok', provenance: { url: BASE, fetched_at: new Date().toISOString() } };
}

module.exports = { fetchReleases };
