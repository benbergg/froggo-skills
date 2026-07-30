'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshTmp, runCli, FIXTURE } = require('./helpers');
const fredSrc = require('../references/scripts/sources/fred-series');
const { buildUrl } = fredSrc;
const B = require('../references/scripts/backfill');
const { HistoryStore } = require('../references/scripts/lib/history-store');

test('T1: FRED 回填走 realtime 区间 + output_type=1,不得用宽表的 output_type=2/3', () => {
  const url = buildUrl('DFII10', { mode: 'vintages', since: '2021-07-01', until: '2026-07-28' }, 'K');
  // realtime 区间是「一次取回全部版本」的关键;缺了它会退化成每日逐次查询,约 5000 次请求必触限
  assert.ok(url.includes('realtime_start=2021-07-01'));
  assert.ok(url.includes('realtime_end=2026-07-28'));
  // output_type=2/3 返回宽表(列名 SERIESID_YYYYMMDD、无 value 键),解析层一行都读不到
  assert.ok(url.includes('output_type=1'), `vintages 必须用 output_type=1: ${url}`);
  assert.equal(/output_type=[23]/.test(url), false, '宽表输出会让整个 FRED 历史落盘成 null');
  assert.ok(url.includes('limit=100000'), '一次性回填须显式给满 limit,避免默认分页静默截断');
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

// —— MF-1:FRED 回填的响应形态断层 ——
// 原先只断言 URL 拼对了(output_type=2),没有任何测试把回来的东西喂进解析层。
// 「参数拼对了」与「回来的东西解析对了」之间的断层让整库落成 null 而全程 exit 0。

test('T13: 宽表响应(output_type=2 形态)必须让该序列进 failed 且不写 meta', async () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const plan = B.buildPlan({ since: '2021-07-01', until: '2026-07-28' })
    .filter((p) => p.series === 'fred_DFII10');
  const wide = JSON.parse(fs.readFileSync(FIXTURE('fred-DFII10.widetable.raw.json'), 'utf-8'));
  const fetchers = {
    fred: async (item) => fredSrc.fetchSeries(item.range, {
      seriesId: item.seriesId, series: item.series, apiKey: 'k',
      fetchImpl: async () => ({ ok: true, json: async () => wide }),
    }),
  };
  const { ok, failed } = await B.runBackfill({ store, plan, fetchers });
  assert.equal(ok.length, 0, '形态不符时不得报成功');
  assert.equal(failed.length, 1);
  assert.equal((store.meta().series || {}).fred_DFII10, undefined,
    '不写 meta 才能保证缺口下次续跑仍被列为待办,而不是被标成「已回填完整」');
  assert.equal(store.readAll('fred_DFII10').length, 0, '一条 value:null 都不许落盘');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T14: 逐 (date, vintage) 行响应落盘出有限值,且 available_date 不全相等', async () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const plan = B.buildPlan({ since: '2021-07-01', until: '2026-07-28' })
    .filter((p) => p.series === 'fred_DFII10');
  const raw = JSON.parse(fs.readFileSync(FIXTURE('fred-DFII10.vintages.raw.json'), 'utf-8'));
  const fetchers = {
    fred: async (item) => fredSrc.fetchSeries(item.range, {
      seriesId: item.seriesId, series: item.series, apiKey: 'k',
      fetchImpl: async () => ({ ok: true, json: async () => raw }),
    }),
  };
  const { ok, failed } = await B.runBackfill({ store, plan, fetchers });
  assert.deepEqual(failed, []);
  assert.equal(ok.length, 1);
  const rows = store.readAll('fred_DFII10');
  assert.ok(rows.length >= 3, `落盘行数不足: ${rows.length}`);
  for (const r of rows) assert.ok(Number.isFinite(r.value), `value 必须是有限数: ${JSON.stringify(r)}`);
  // vintage 信息整体丢失的签名就是「available_date 全部等于 --until」——回测期间 FRED
  // 行因此全程不可见,evaluated=0、logistic 永远拿不到系数
  assert.ok(new Set(rows.map((r) => r.available_date)).size > 1,
    `available_date 全相等说明 vintage 信息丢了: ${JSON.stringify(rows.map((r) => r.available_date))}`);
  assert.equal(rows.some((r) => r.available_date === '2026-07-28'), false,
    'available_date 不该退回 --until');
  fs.rmSync(tmp, { recursive: true, force: true });
});
