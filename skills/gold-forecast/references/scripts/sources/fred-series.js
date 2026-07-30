'use strict';
const BASE = 'https://api.stlouisfed.org/fred/series/observations';
// FRED observations 的 limit 上限;不显式给就是同值默认,写出来是为了让截断判定有据可依。
const VINTAGE_LIMIT = 100_000;

// Number('') === 0:空串若走 Number 会静默变成「今天实际利率是 0」,须与缺键同等对待。
function toNumber(v) {
  if (typeof v === 'number') return v;
  return typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
}

// 响应形态不符时必须响亮失败,不能产出 NaN:落盘会变成 value:null 而 status 仍是 'ok',
// 于是 backfill 打 ✓、setMeta 把缺口标成已补齐、永久跳过,而生产端 null-null===0
// 被「特征降级」判为健康 —— 全链路 exit 0 却把整个 FRED 历史毁掉一次。
function parseObservations(raw, series, { availableAt }) {
  return (raw.observations || [])
    .filter((o) => o.value !== '.')
    .map((o) => {
      const value = toNumber(o.value);
      if (!Number.isFinite(value) || typeof o.date !== 'string') {
        throw new Error(`${series} 观测行形态异常(date=${JSON.stringify(o.date)} value=${JSON.stringify(o.value)});`
          + ' 期望 output_type=1 的逐行 {date, value, realtime_start} 结构');
      }
      return { series, observed_date: o.date,
        // 观测日与可得日不同 —— 实测 DTWEXBGS 滞后达 5 天。
        available_date: o.realtime_start && o.realtime_start > o.date ? o.realtime_start : availableAt,
        vintage: o.realtime_start || availableAt, value };
    })
    .sort((a, b) => (a.observed_date < b.observed_date ? -1 : 1));
}

// mode='vintages' 一次取回整个回填窗口的全部版本:
// 朴素做法是每天一次 realtime 查询,4 序列 x 5 年 x 250 天约 5000 次请求,必然触限。
//
// 必须是 output_type=1 而不是 2:output_type=2/3 返回的是**宽表**——列名动态拼成
// `SERIESID_YYYYMMDD`、根本没有 `value` 键,parseObservations 一行都读不到。
// output_type=1 配 realtime 区间返回的就是逐 (date, vintage) 行,realtime_start
// 语义正确、现有解析一行不用改,请求数与 output_type=2 相同。
function buildUrl(seriesId, range, apiKey) {
  const p = new URLSearchParams({ series_id: seriesId, file_type: 'json', api_key: apiKey });
  if (range.mode === 'vintages') {
    p.set('output_type', '1');
    if (range.since) p.set('realtime_start', range.since);
    p.set('realtime_end', range.until);
    p.set('limit', String(VINTAGE_LIMIT));
  } else { p.set('sort_order', 'desc'); p.set('limit', '120'); }
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
    // vintages 是一次性回填,分页静默截断会让残缺窗口被 setMeta 标成已补齐、缺口永久跳过
    // (本仓库已两次栽在静默丢页上)。非 vintages 模式的 limit=120 是刻意截断,不适用。
    // 比的是 observations 长度而非 records:"." 缺失值被合法丢弃,拿 records 比会把
    // 每个假期都误判成丢页。
    const got = (raw.observations || []).length;
    if (range.mode === 'vintages' && Number.isFinite(raw.count) && got + (raw.offset || 0) < raw.count) {
      throw new Error(`${series} 回填被分页截断: count=${raw.count} 实收=${got} offset=${raw.offset || 0}`);
    }
    // 200 但空数组/结构变了不等于「今天确实没有新数据」,status 必须跟着 records 走(与 fixture 分支同规则)。
    return { records, status: records.length ? 'ok' : 'missing',
             provenance: { url: BASE, fetched_at: new Date().toISOString() } };
  } catch (e) {
    return { records: [], status: 'missing', error: e.message,
             provenance: { url: BASE, fetched_at: new Date().toISOString() } };
  } finally { clearTimeout(timer); }
}

module.exports = { parseObservations, buildUrl, fetchSeries };
