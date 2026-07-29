'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseLbma, fetchRaw } = require('./sources/lbma-gold-pm');
const { HistoryStore } = require('./lib/history-store');
const { atomicWriteJSON } = require('./lib/atomic-write');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = args.fixture
    ? JSON.parse(fs.readFileSync(args.fixture, 'utf-8'))
    : await fetchRaw();

  const records = parseLbma(raw);
  if (records.length === 0) { console.error('LBMA 无有效记录'); process.exit(4); }

  const latest = records[records.length - 1];
  // 只判 HTTP 成功会让陈旧数据被当成当日价 —— 必须比对预期交易日。
  const freshnessOk = !args['expect-session'] || latest.observed_date >= args['expect-session'];
  if (!freshnessOk) {
    console.error(`LBMA 数据陈旧: 最新 ${latest.observed_date} < 预期 ${args['expect-session']}`);
    process.exit(4);
  }

  const store = new HistoryStore(path.resolve(args.history));
  store.upsert('lbma_pm_usd', records);

  atomicWriteJSON(path.resolve(args.out), {
    series: 'lbma_pm_usd',
    fetched_at: new Date().toISOString(),
    latest: { date: latest.observed_date, value: latest.value },
    // 下游 settle.js 靠 history 按目标日结算 T+5/T+20,只留 latest 会让它们永远命中不到。
    history: records.slice(-60).map((r) => ({ date: r.observed_date, value: r.value })),
    calendar_tail: records.slice(-60).map((r) => r.observed_date),
    freshness_ok: true,
  });
  console.error(`结算价 ${latest.observed_date} = ${latest.value}, 历史 ${records.length} 条`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
