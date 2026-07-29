'use strict';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const BASE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';

// 日 K 收盘当日即可得,故三个日期同日。
function parseKline(raw, series) {
  const lines = (raw && raw.data && raw.data.klines) || [];
  return lines.map((l) => {
    const [d, o, c, h, lo, v] = l.split(',');
    return { series, observed_date: d, available_date: d, vintage: d,
             value: { o: +o, c: +c, h: +h, l: +lo, v: +v } };
  });
}

async function fetchSeries(range, { secid, series, timeoutMs = 30_000 } = {}) {
  const url = `${BASE}?secid=${secid}&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56`
            + `&klt=101&fqt=0&end=20500101&lmt=${range.mode === 'full' ? 5000 : 60}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, signal: ctrl.signal });
    if (!res.ok) return { records: [], status: 'missing', provenance: { url, fetched_at: new Date().toISOString() } };
    return { records: parseKline(await res.json(), series), status: 'ok',
             provenance: { url, fetched_at: new Date().toISOString() } };
  } catch {
    return { records: [], status: 'missing', provenance: { url, fetched_at: new Date().toISOString() } };
  } finally { clearTimeout(timer); }
}

module.exports = { parseKline, fetchSeries };
