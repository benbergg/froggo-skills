'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { HistoryStore } = require('./lib/history-store');
const { fetchSeries: fetchLbma } = require('./sources/lbma-gold-pm');
const { fetchSeries: fetchFred } = require('./sources/fred-series');
const { fetchSeries: fetchEastmoney } = require('./sources/eastmoney-kline');
const { fetchSeries: fetchCftcHistory } = require('./sources/cftc-cot-history');

const GOLD = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'instruments', 'gold.json'), 'utf-8'));

function buildPlan({ since, until }) {
  const plan = [{ series: 'lbma_pm_usd', kind: 'lbma', range: { since: null, until, mode: 'full' } }];
  for (const s of GOLD.fred_series) {
    // vintages 模式一次取回全部历史版本,避免逐日查询触发配额。
    plan.push({ series: `fred_${s}`, kind: 'fred', seriesId: s, range: { since, until, mode: 'vintages' } });
  }
  for (const [series, secid] of Object.entries(GOLD.eastmoney_secids)) {
    plan.push({ series, kind: 'eastmoney', secid, range: { since, until, mode: 'full' } });
  }
  plan.push({ series: 'cftc_gold', kind: 'cot-history', range: { since, until, mode: 'full' } });
  return plan;
}

function pendingSeries(store, plan) {
  const meta = store.meta().series || {};
  return plan.filter((p) => !meta[p.series] || meta[p.series].until < p.range.until);
}

function applyOnly(plan, only) {
  return only ? plan.filter((p) => p.series === only) : plan;
}

// 逐序列抓取实现,按 kind 分派;测试注入受控成功/失败实现以避免联网。
const DEFAULT_FETCHERS = {
  lbma: async () => fetchLbma({}),
  fred: async (item, ctx) => {
    if (!ctx.fredApiKey) return { records: [], status: 'missing', error: 'FRED_API_KEY 未设置' };
    return fetchFred(item.range, { seriesId: item.seriesId, series: item.series, apiKey: ctx.fredApiKey });
  },
  eastmoney: async (item) => fetchEastmoney(item.range, { secid: item.secid, series: item.series }),
  'cot-history': async (item, ctx) => fetchCftcHistory(item.range, { cacheDir: ctx.cacheDir }),
};

// 逐序列:拉取 -> upsert -> 立刻 setMeta,顺序不能反——反过来会让崩溃永久跳过该序列。
// 单序列失败不中断整轮,失败与成功都汇总返回供调用方决定退出码。
async function runBackfill({ store, plan, fetchers = DEFAULT_FETCHERS, fredApiKey = process.env.FRED_API_KEY, cacheDir, log = () => {} }) {
  const todo = pendingSeries(store, plan);
  const ok = [];
  const failed = [];
  for (const item of todo) {
    try {
      const fetcher = fetchers[item.kind];
      if (!fetcher) throw new Error(`未知采集类型: ${item.kind}`);
      const r = await fetcher(item, { fredApiKey, cacheDir });
      if (!r || r.status !== 'ok') throw new Error((r && r.error) || `拉取失败(status=${r && r.status})`);
      const { inserted, updated } = store.upsert(item.series, r.records);
      // setMeta 是浅合并,须先取出 series 整体再回写,否则会冲掉其他序列已记录的进度。
      const seriesMeta = store.meta().series || {};
      store.setMeta({
        series: { ...seriesMeta, [item.series]: { last_backfilled_at: new Date().toISOString(), until: item.range.until } },
      });
      ok.push({ series: item.series, inserted, updated });
      log(`✓ ${item.series}: inserted=${inserted} updated=${updated}`);
    } catch (e) {
      failed.push({ series: item.series, error: e.message });
      log(`✗ ${item.series}: ${e.message}`);
    }
  }
  return { ok, failed };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.history || !args.since || !args.until) {
    console.error('缺少必需参数: --history --since --until');
    process.exit(1);
    return;
  }
  const historyDir = path.resolve(args.history);
  // 年度 zip 缓存放 history 旁边,与建模用的 history/ 目录分开,避免被当作序列数据扫入。
  const cacheDir = path.join(path.dirname(historyDir), 'cache', 'cot');
  const store = new HistoryStore(historyDir);
  const plan = applyOnly(buildPlan({ since: args.since, until: args.until }), args.only);

  const { ok, failed } = await runBackfill({ store, plan, cacheDir, log: (m) => console.error(m) });
  console.error(`回填完成: 成功 ${ok.length}, 失败 ${failed.length}`);
  if (failed.length) {
    console.error(`失败序列: ${failed.map((f) => `${f.series}(${f.error})`).join('; ')}`);
    process.exit(ok.length ? 2 : 1);
    return;
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { buildPlan, pendingSeries, applyOnly, runBackfill, DEFAULT_FETCHERS };
