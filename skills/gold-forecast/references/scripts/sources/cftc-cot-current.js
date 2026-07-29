'use strict';
const URL_CUR = 'https://www.cftc.gov/dea/newcot/deafut.txt';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';

const num = (s) => Number(String(s).trim());

// 文件无表头 129 字段,列映射由四条会计恒等式验证。
// 断言失败即判定 CFTC 变更格式,绝不静默产出错误持仓。
function parseCot(text) {
  const line = text.split('\n').find((l) => l.startsWith('"GOLD - COMMODITY'));
  if (!line) throw new Error('COT 未找到黄金行');
  const f = line.split(',');
  const r = {
    observed_date: f[2].trim(),
    open_interest: num(f[7]),
    nc_long: num(f[8]), nc_short: num(f[9]), nc_spread: num(f[10]),
    comm_long: num(f[11]), comm_short: num(f[12]),
    rep_long: num(f[13]), rep_short: num(f[14]),
    nonrep_long: num(f[15]), nonrep_short: num(f[16]),
  };
  const ok = r.nc_long + r.nc_spread + r.comm_long === r.rep_long
          && r.nc_short + r.nc_spread + r.comm_short === r.rep_short
          && r.rep_long + r.nonrep_long === r.open_interest
          && r.rep_short + r.nonrep_short === r.open_interest;
  if (!ok) throw new Error('COT 会计恒等式不成立,疑似列映射变更');
  r.net_spec = r.nc_long - r.nc_short;
  r.net_comm = r.comm_long - r.comm_short;
  r.net_nonrep = r.nonrep_long - r.nonrep_short;
  return r;
}

// 数据是周二收盘持仓,周五 15:30 ET 才公布 —— 按数据日对齐即前视偏差。
function cotAvailableDate(observedDate) {
  const d = new Date(observedDate + 'T00:00:00Z');
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 5);
  return d.toISOString().slice(0, 10);
}

// fetchImpl 可注入,测试借此模拟 HTTP 失败/网络异常,不必发真实请求。
async function fetchSeries(range, { timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(URL_CUR, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) {
      return { records: [], status: 'missing', error: `HTTP ${res.status}`,
               provenance: { url: URL_CUR, fetched_at: new Date().toISOString() } };
    }
    const r = parseCot(await res.text());
    return { records: [{ series: 'cftc_gold', observed_date: r.observed_date,
                         available_date: cotAvailableDate(r.observed_date),
                         vintage: cotAvailableDate(r.observed_date), value: r }],
             status: 'ok', provenance: { url: URL_CUR, fetched_at: new Date().toISOString() } };
  } catch (e) {
    return { records: [], status: 'missing', error: e.message, provenance: { url: URL_CUR, fetched_at: new Date().toISOString() } };
  } finally { clearTimeout(timer); }
}

module.exports = { parseCot, cotAvailableDate, fetchSeries };
