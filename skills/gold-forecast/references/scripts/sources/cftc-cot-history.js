'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseCot, cotAvailableDate } = require('./cftc-cot-current');

const YEAR_URL = (y) => `https://www.cftc.gov/files/dea/history/deacot${y}.zip`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';

// fetchImpl 可注入,测试借此模拟单年 HTTP 失败,不必发真实请求。
async function fetchYear(year, cacheDir, { timeoutMs = 30_000, fetchImpl = fetch } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const zip = path.join(cacheDir, `deacot${year}.zip`);
  if (!fs.existsSync(zip)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(YEAR_URL(year), { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      // 网络/HTTP 失败必须抛错,不能与"格式漂移"用两套失败语义——都得让调用方的 failedYears 记到账。
      if (!res.ok) throw new Error(`CFTC 历史 ${year} HTTP ${res.status}`);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    } finally { clearTimeout(timer); }
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cot-'));
  spawnSync('unzip', ['-o', '-q', zip, '-d', out]);
  const txt = fs.readdirSync(out).find((f) => /\.txt$/i.test(f));
  if (!txt) { fs.rmSync(out, { recursive: true, force: true }); throw new Error(`CFTC 历史 ${year} 压缩包解压后未找到 txt`); }
  const lines = fs.readFileSync(path.join(out, txt), 'utf-8')
    .split('\n').filter((l) => l.startsWith('"GOLD - COMMODITY'));
  fs.rmSync(out, { recursive: true, force: true });
  return lines.map((l) => {
    const r = parseCot(l);                       // 格式漂移在此抛错,由调用方逐年兜底
    return { series: 'cftc_gold', observed_date: r.observed_date,
             available_date: cotAvailableDate(r.observed_date),
             vintage: cotAvailableDate(r.observed_date), value: r };
  });
}

// fetchYearImpl 可注入,测试借此模拟单年网络失败/格式漂移,不必发真实请求。
async function fetchSeries(range, { cacheDir, fetchYearImpl = fetchYear } = {}) {
  const y0 = Number((range.since || range.until).slice(0, 4));
  const y1 = Number(range.until.slice(0, 4));
  const records = [];
  const failedYears = [];
  for (let y = y0; y <= y1; y++) {
    // 跳过失败年份是安全的(没数据),吞掉恒等式抛错继续拼装才危险。
    try { records.push(...await fetchYearImpl(y, cacheDir)); }
    catch { failedYears.push(y); }
  }
  return { records, status: records.length ? 'ok' : 'missing', failed_years: failedYears,
           provenance: { url: YEAR_URL(y1), fetched_at: new Date().toISOString() } };
}

module.exports = { fetchSeries, fetchYear };
