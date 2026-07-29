'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseCot, cotAvailableDate } = require('./cftc-cot-current');

const YEAR_URL = (y) => `https://www.cftc.gov/files/dea/history/deacot${y}.zip`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';

async function fetchYear(year, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const zip = path.join(cacheDir, `deacot${year}.zip`);
  if (!fs.existsSync(zip)) {
    const res = await fetch(YEAR_URL(year), { headers: { 'User-Agent': UA } });
    if (!res.ok) return [];
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cot-'));
  spawnSync('unzip', ['-o', '-q', zip, '-d', out]);
  const txt = fs.readdirSync(out).find((f) => /\.txt$/i.test(f));
  if (!txt) return [];
  const lines = fs.readFileSync(path.join(out, txt), 'utf-8')
    .split('\n').filter((l) => l.startsWith('"GOLD - COMMODITY'));
  fs.rmSync(out, { recursive: true, force: true });
  return lines.map((l) => {
    const r = parseCot(l);
    return { series: 'cftc_gold', observed_date: r.observed_date,
             available_date: cotAvailableDate(r.observed_date),
             vintage: cotAvailableDate(r.observed_date), value: r };
  });
}

async function fetchSeries(range, { cacheDir } = {}) {
  const y0 = Number((range.since || range.until).slice(0, 4));
  const y1 = Number(range.until.slice(0, 4));
  const records = [];
  for (let y = y0; y <= y1; y++) records.push(...await fetchYear(y, cacheDir));
  return { records, status: records.length ? 'ok' : 'missing',
           provenance: { url: YEAR_URL(y1), fetched_at: new Date().toISOString() } };
}

module.exports = { fetchSeries, fetchYear };
