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

// fetchImpl 可注入,测试借此模拟 200-空数组/结构畸形/HTTP 失败,不必发真实请求。
async function fetchSeries(range, { secid, series, timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const url = `${BASE}?secid=${secid}&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56`
            + `&klt=101&fqt=0&end=20500101&lmt=${range.mode === 'full' ? 5000 : 60}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, signal: ctrl.signal });
    if (!res.ok) {
      return { records: [], status: 'missing', error: `HTTP ${res.status}`,
               provenance: { url, fetched_at: new Date().toISOString() } };
    }
    const records = parseKline(await res.json(), series);
    // data.klines 缺失或为空数组时 parseKline 返回 [],不能仍标 'ok'——见 fred-series.js 同型修复。
    return { records, status: records.length ? 'ok' : 'missing',
             provenance: { url, fetched_at: new Date().toISOString() } };
  } catch (e) {
    return { records: [], status: 'missing', error: e.message,
             provenance: { url, fetched_at: new Date().toISOString() } };
  } finally { clearTimeout(timer); }
}

module.exports = { parseKline, fetchSeries };
