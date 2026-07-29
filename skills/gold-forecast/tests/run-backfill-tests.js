'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshTmp, runCli } = require('./helpers');
const { buildUrl } = require('../references/scripts/sources/fred-series');
const B = require('../references/scripts/backfill');
const { HistoryStore } = require('../references/scripts/lib/history-store');

test('T1: FRED 回填必须走 vintages 模式', () => {
  const url = buildUrl('DFII10', { mode: 'vintages', since: '2021-07-01', until: '2026-07-28' }, 'K');
  assert.ok(url.includes('output_type=2'), '缺 output_type=2 会退化成每日逐次查询,约 5000 次请求必触限');
  assert.ok(url.includes('realtime_start=2021-07-01'));
  assert.ok(url.includes('realtime_end=2026-07-28'));
});

test('T2: 非 vintages 模式不带 output_type', () => {
  const url = buildUrl('DFII10', { mode: 'incremental', until: '2026-07-28' }, 'K');
  assert.equal(url.includes('output_type'), false);
});

test('T3: 计划表覆盖全部必需序列', () => {
  const plan = B.buildPlan({ since: '2021-07-01', until: '2026-07-28' });
  const names = plan.map((p) => p.series);
  for (const s of ['lbma_pm_usd', 'fred_DFII10', 'fred_DTWEXBGS', 'cftc_gold', 'eastmoney_UDI']) {
    assert.ok(names.includes(s), `回填计划缺 ${s}`);
  }
});

test('T4: 已完成的序列在续跑时被跳过', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  store.setMeta({ series: { lbma_pm_usd: { last_backfilled_at: '2026-07-29', until: '2026-07-28' } } });
  const todo = B.pendingSeries(store, B.buildPlan({ since: '2021-07-01', until: '2026-07-28' }));
  assert.equal(todo.some((p) => p.series === 'lbma_pm_usd'), false, '续跑不应重复拉已完成序列');
  assert.ok(todo.length > 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T5: until 变新时该序列重新进入待办', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  store.setMeta({ series: { lbma_pm_usd: { last_backfilled_at: '2026-07-20', until: '2026-07-19' } } });
  const todo = B.pendingSeries(store, B.buildPlan({ since: '2021-07-01', until: '2026-07-28' }));
  assert.ok(todo.some((p) => p.series === 'lbma_pm_usd'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// —— CLI 主体:通过注入 fetchers 覆盖 runBackfill,不联网 ——

function stubRecord(series, date) {
  return { series, observed_date: date, available_date: date, vintage: date, value: 1 };
}

const OK_FETCHERS = {
  lbma: async () => ({ status: 'ok', records: [stubRecord('lbma_pm_usd', '2021-07-01')] }),
  fred: async (item) => ({ status: 'ok', records: [stubRecord(item.series, '2021-07-01')] }),
  eastmoney: async (item) => ({ status: 'ok', records: [stubRecord(item.series, '2021-07-01')] }),
  'cot-history': async () => ({ status: 'ok', records: [stubRecord('cftc_gold', '2021-07-02')] }),
};

test('T6: 正常跑完后 meta.json 里每个成功序列都有 last_backfilled_at 与 until', async () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const plan = B.buildPlan({ since: '2021-07-01', until: '2026-07-28' });
  const { ok, failed } = await B.runBackfill({ store, plan, fetchers: OK_FETCHERS });
  assert.deepEqual(failed, []);
  assert.equal(ok.length, plan.length);
  const meta = store.meta().series;
  for (const p of plan) {
    assert.ok(meta[p.series] && meta[p.series].last_backfilled_at, `${p.series} 缺 last_backfilled_at`);
    assert.equal(meta[p.series].until, p.range.until);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T7: 某序列失败时,其余序列照常完成且进度被记录(浅合并不冲掉其他序列)', async () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const plan = B.buildPlan({ since: '2021-07-01', until: '2026-07-28' });
  const fetchers = { ...OK_FETCHERS, fred: async () => ({ status: 'missing', error: 'FRED 模拟失败' }) };
  const { ok, failed } = await B.runBackfill({ store, plan, fetchers });
  const fredSeries = plan.filter((p) => p.kind === 'fred').map((p) => p.series);
  assert.deepEqual(failed.map((f) => f.series).sort(), fredSeries.sort());
  const meta = store.meta().series;
  assert.ok(meta.lbma_pm_usd, 'lbma 应正常记录进度');
  assert.ok(meta.cftc_gold, 'cot-history 应正常记录进度');
  assert.ok(meta.eastmoney_UDI, 'eastmoney 应正常记录进度');
  for (const s of fredSeries) assert.equal(meta[s], undefined, `${s} 失败不应留下进度`);
  assert.equal(ok.length + failed.length, plan.length);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T8: --only <series> 确实只跑那一个', async () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const plan = B.applyOnly(B.buildPlan({ since: '2021-07-01', until: '2026-07-28' }), 'lbma_pm_usd');
  assert.deepEqual(plan.map((p) => p.series), ['lbma_pm_usd']);
  const fetchers = {
    lbma: OK_FETCHERS.lbma,
    fred: async () => { throw new Error('不应调用 fred fetcher'); },
    eastmoney: async () => { throw new Error('不应调用 eastmoney fetcher'); },
    'cot-history': async () => { throw new Error('不应调用 cot-history fetcher'); },
  };
  const { ok, failed } = await B.runBackfill({ store, plan, fetchers });
  assert.equal(failed.length, 0);
  assert.deepEqual(ok.map((o) => o.series), ['lbma_pm_usd']);
  assert.deepEqual(Object.keys(store.meta().series), ['lbma_pm_usd']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T9: CLI 缺少必需参数时 exit 1,不联网', () => {
  const r = runCli({ script: 'backfill.js', args: ['--history', 'hist'] });
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes('缺少必需参数'));
  r.cleanup();
});

test('T10: FRED_API_KEY 缺失时该序列记为失败而不是崩溃', async () => {
  const item = { series: 'fred_DFII10', seriesId: 'DFII10', range: { since: '2021-07-01', until: '2026-07-28', mode: 'vintages' } };
  const r = await B.DEFAULT_FETCHERS.fred(item, { fredApiKey: undefined });
  assert.equal(r.status, 'missing');
  assert.ok(r.error, '应说明缺 key 的原因,而不是抛异常让上层崩溃');
});

test('T11: cot-history 部分年份失败时不得静默标记为完整回填', async () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const plan = B.buildPlan({ since: '2021-07-01', until: '2026-07-28' });
  // sources/cftc-cot-history.js 的真实契约:逐年容错,部分成功仍 status:'ok',
  // 失败年份靠 failed_years 上报——调用方必须自己识别这个信号,不能只看 status。
  const partialCot = async () => ({
    status: 'ok',
    records: [stubRecord('cftc_gold', '2021-07-02')],
    failed_years: [2023],
  });
  const fetchers = { ...OK_FETCHERS, 'cot-history': partialCot };
  const logs = [];
  const { failed } = await B.runBackfill({ store, plan, fetchers, log: (m) => logs.push(m) });

  const cotFailure = failed.find((f) => f.series === 'cftc_gold');
  assert.ok(cotFailure, 'cot-history 部分年份失败应计入 failed,不能悄悄算成功');
  assert.ok(cotFailure.error.includes('2023'), `失败原因应带上缺失年份: ${cotFailure.error}`);
  assert.ok(logs.some((l) => l.includes('2023')), 'failed_years 必须出现在日志里,不能被静默吞掉');

  assert.equal((store.meta().series || {}).cftc_gold, undefined, '部分失败不得标记为完整覆盖,否则续跑会永久跳过缺口');
  const todo2 = B.pendingSeries(store, plan);
  assert.ok(todo2.some((p) => p.series === 'cftc_gold'), '部分失败后下一次续跑必须仍把该序列列为待办');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T12: --only 指定不存在的序列名时报错退出,不静默产出 0/0', () => {
  const r = runCli({
    script: 'backfill.js',
    args: ['--history', 'hist', '--since', '2021-07-01', '--until', '2026-07-28', '--only', 'not_a_series'],
  });
  assert.notEqual(r.code, 0, '拼错序列名不该假装跑完了');
  assert.ok(r.stderr.includes('not_a_series'));
  assert.ok(r.stderr.includes('lbma_pm_usd'), '应列出合法序列名帮助定位拼写错误');
  r.cleanup();
});
