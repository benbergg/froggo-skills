'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshTmp, FIXTURE, runCli } = require('./helpers');
const C = require('../references/scripts/collect-facts');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'references', 'schemas', 'facts.schema.json'), 'utf-8'));

test('T1: 预测硬依赖缺失被识别', () => {
  const r = C.classify({ 'lbma.pm_usd': 'ok', 'fred.DFII10': 'missing', 'eastmoney.UDI': 'ok' }, SCHEMA);
  assert.deepEqual(r.forecastHardMissing, ['fred.DFII10']);
});

test('T2: 软依赖缺失不算硬失败', () => {
  const r = C.classify({ 'lbma.pm_usd': 'ok', 'fred.DFII10': 'ok', 'eastmoney.UDI': 'ok', 'cftc.net_spec': 'missing' }, SCHEMA);
  assert.deepEqual(r.forecastHardMissing, []);
  assert.ok(r.missing.includes('cftc.net_spec'));
});

test('T3: 等级判定完全来自 schema,不在代码里硬编码', () => {
  // 临时把 UDI 降级为 soft,分类结果须随之改变
  const patched = JSON.parse(JSON.stringify(SCHEMA));
  patched.fields['eastmoney.UDI'].dependency = 'soft';
  const r = C.classify({ 'eastmoney.UDI': 'missing' }, patched);
  assert.deepEqual(r.forecastHardMissing, [], 'schema 改了行为就该改');
});

// —— context_tags:必须确定性推导 ——

test('T4: 发布日历驱动 pre_cpi', () => {
  const tags = C.deriveContextTags({
    target_date: '2026-08-12',
    calendar: { next_releases: { cpi: ['2026-08-12'], nfp: [], pce: [] } },
  }, {});
  assert.ok(tags.includes('pre_cpi'));
});

test('T5: 发布前一交易日也算 pre_cpi', () => {
  const tags = C.deriveContextTags({
    target_date: '2026-08-11', prev_session: '2026-08-11',
    calendar: { next_releases: { cpi: ['2026-08-12'], nfp: [], pce: [] } },
  }, {});
  assert.ok(tags.includes('pre_cpi'));
});

test('T6: 持仓分位驱动 crowded_long / crowded_short', () => {
  assert.ok(C.deriveContextTags({ cftc: { spec_pctile: 0.9 } }, {}).includes('crowded_long'));
  assert.ok(C.deriveContextTags({ cftc: { spec_pctile: 0.1 } }, {}).includes('crowded_short'));
  assert.equal(C.deriveContextTags({ cftc: { spec_pctile: 0.5 } }, {}).some((t) => t.startsWith('crowded')), false);
});

test('T7: COT 陈旧驱动 stale_cot', () => {
  const tags = C.deriveContextTags({ target_date: '2026-08-05', cftc: { available_date: '2026-07-24' } }, {});
  assert.ok(tags.includes('stale_cot'));
});

test('T8: 波动率高分位驱动 high_vol', () => {
  assert.ok(C.deriveContextTags({}, { sigmaPctile: 0.9 }).includes('high_vol'));
});

test('T9: 产出的标签全部落在 schema 封闭集合内', () => {
  const tags = C.deriveContextTags({
    target_date: '2026-08-12', cftc: { spec_pctile: 0.95, available_date: '2026-06-01' },
    calendar: { next_releases: { cpi: ['2026-08-12'], nfp: ['2026-08-12'], pce: ['2026-08-12'] } },
  }, { sigmaPctile: 0.99 });
  const bad = tags.filter((t) => !SCHEMA.context_tags.includes(t));
  assert.deepEqual(bad, [], `越界标签会让教训匹配静默失配: ${bad.join(',')}`);
});

// —— 事务边界 ——

test('T10: facts 写失败时回滚当日 history 记录', () => {
  const tmp = freshTmp();
  const hist = path.join(tmp, 'h');
  // out 指向一个不可写路径,迫使 facts 写入失败
  const bad = path.join(tmp, 'nodir', 'x', 'facts.json');
  fs.mkdirSync(path.dirname(path.dirname(bad)), { recursive: true });
  fs.writeFileSync(path.dirname(bad), '');   // 用文件占位,使 mkdir 失败
  assert.throws(() => C.writeWithRollback({
    historyDir: hist, factsPath: bad,
    appended: { lbma_pm_usd: [{ observed_date: '2026-07-29', available_date: '2026-07-29', vintage: '2026-07-29', value: 1 }] },
    facts: { x: 1 },
  }));
  const f = path.join(hist, 'lbma_pm_usd.jsonl');
  const rows = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean) : [];
  assert.equal(rows.length, 0, '建模源与快照不得分叉');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T11: 正常路径下 history 与 facts 都写成功', () => {
  const tmp = freshTmp();
  C.writeWithRollback({
    historyDir: path.join(tmp, 'h'), factsPath: path.join(tmp, 'facts.json'),
    appended: { lbma_pm_usd: [{ observed_date: '2026-07-29', available_date: '2026-07-29', vintage: '2026-07-29', value: 1 }] },
    facts: { x: 1 },
  });
  assert.ok(fs.existsSync(path.join(tmp, 'facts.json')));
  assert.ok(fs.readFileSync(path.join(tmp, 'h', 'lbma_pm_usd.jsonl'), 'utf-8').includes('2026-07-29'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// —— A3:回滚"更新已有 key"必须恢复旧值,不能整条删除 ——

test('T11b(A3): 同一天重跑撞见已存在的 key,facts 写失败时回滚恢复写入前的旧值', () => {
  const tmp = freshTmp();
  const hist = path.join(tmp, 'h');
  // 第一次成功写入 value:3400
  C.writeWithRollback({
    historyDir: hist, factsPath: path.join(tmp, 'facts1.json'),
    appended: { lbma_pm_usd: [{ observed_date: '2026-07-29', available_date: '2026-07-29', vintage: '2026-07-29', value: 3400 }] },
    facts: { x: 1 },
  });
  // 第二次重跑同一 key 改成 3500,但 facts 写入被迫失败
  const bad = path.join(tmp, 'nodir', 'x', 'facts2.json');
  fs.mkdirSync(path.dirname(path.dirname(bad)), { recursive: true });
  fs.writeFileSync(path.dirname(bad), '');
  assert.throws(() => C.writeWithRollback({
    historyDir: hist, factsPath: bad,
    appended: { lbma_pm_usd: [{ observed_date: '2026-07-29', available_date: '2026-07-29', vintage: '2026-07-29', value: 3500 }] },
    facts: { x: 2 },
  }));
  const rows = fs.readFileSync(path.join(hist, 'lbma_pm_usd.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, '回滚不得把已存在的记录整条删除');
  assert.equal(rows[0].value, 3400, '回滚必须恢复写入前的旧值,而不是留下本次半写的新值');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// —— A4:upsert 循环体本身失败也要回滚已写入的其他 series ——

test('T11c(A4): 第 2 个 series 的 upsert 失败时,第 1 个已落盘的记录也会被回滚', () => {
  const tmp = freshTmp();
  const hist = path.join(tmp, 'h');
  fs.mkdirSync(hist, { recursive: true });
  // series_b.jsonl 预先占位成目录,迫使它的 upsert 内部写入必然抛错
  fs.mkdirSync(path.join(hist, 'series_b.jsonl'), { recursive: true });
  assert.throws(() => C.writeWithRollback({
    historyDir: hist, factsPath: path.join(tmp, 'facts.json'),
    appended: {
      series_a: [{ observed_date: '2026-07-29', available_date: '2026-07-29', vintage: '2026-07-29', value: 1 }],
      series_b: [{ observed_date: '2026-07-29', available_date: '2026-07-29', vintage: '2026-07-29', value: 2 }],
    },
    facts: { x: 1 },
  }));
  const fa = path.join(hist, 'series_a.jsonl');
  const rowsA = fs.existsSync(fa) ? fs.readFileSync(fa, 'utf-8').split('\n').filter(Boolean) : [];
  assert.equal(rowsA.length, 0, 'series_a 已落盘的记录必须回滚,不能因 series_b 失败留下半截产物');
  assert.equal(fs.existsSync(path.join(tmp, 'facts.json')), false, 'facts.json 不应被写出');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// —— CLI 主体:--fixture-dir 模式 ——
// 约定见 collect-facts.js 顶部注释:lbma.raw.json / fred-<ID>.raw.json /
// eastmoney-<suffix>.raw.json / cftc-current.raw.txt / fred-releases.json / news.json

function makeFixtureDir({ dfii10 = true, udi = true } = {}) {
  const dir = freshTmp();
  fs.copyFileSync(FIXTURE('lbma-gold-pm.raw.json'), path.join(dir, 'lbma.raw.json'));
  if (dfii10) fs.copyFileSync(FIXTURE('fred-DFII10.raw.json'), path.join(dir, 'fred-DFII10.raw.json'));
  if (udi) fs.copyFileSync(FIXTURE('eastmoney-kline.raw.json'), path.join(dir, 'eastmoney-UDI.raw.json'));
  fs.copyFileSync(FIXTURE('cftc-deafut.raw.txt'), path.join(dir, 'cftc-current.raw.txt'));
  return dir;
}

test('T12: --fixture-dir 模式正常产出 facts.json 且 _missing 正确', () => {
  const fixtureDir = makeFixtureDir();
  const r = runCli({
    script: 'collect-facts.js',
    args: ['--out', 'out/facts.json', '--history', 'hist', '--today', '2026-07-29', '--fixture-dir', fixtureDir],
  });
  assert.equal(r.code, 0, r.stderr);
  const facts = JSON.parse(fs.readFileSync(path.join(r.tmp, 'out', 'facts.json'), 'utf-8'));
  // 只喂了 lbma/fred.DFII10/eastmoney.UDI/cftc-current 四份夹具,其余全部字段应落 missing
  assert.deepEqual(facts._missing, [
    'fred.T10YIE', 'fred.DFF', 'eastmoney.SPX', 'eastmoney.aum', 'eastmoney.518880',
    'cftc.spec_pctile', 'calendar.next_releases', 'news.items',
  ]);
  assert.equal(facts.fields['lbma.pm_usd'].status, 'ok');
  assert.equal(facts.fields['fred.DFII10'].status, 'ok');
  assert.equal(facts.fields['eastmoney.UDI'].status, 'ok');
  r.cleanup();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test('T13: 预测硬依赖缺失时 exit 3 且不留产物', () => {
  const fixtureDir = makeFixtureDir({ dfii10: false });   // 缺 fred.DFII10(forecast_hard)
  const r = runCli({
    script: 'collect-facts.js',
    args: ['--out', 'out/facts.json', '--history', 'hist', '--today', '2026-07-29', '--fixture-dir', fixtureDir],
  });
  assert.equal(r.code, 3);
  assert.equal(fs.existsSync(path.join(r.tmp, 'out', 'facts.json')), false);
  assert.equal(fs.existsSync(path.join(r.tmp, 'hist')), false, '不得留下半截产物');
  r.cleanup();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test('T14: LBMA fixture 数据格式错误时输出诊断日志', () => {
  const fixtureDir = freshTmp();
  // lbma.raw.json 写成有效 JSON 但不是数组(数字),迫使 parseLbma for 循环抛异常
  fs.writeFileSync(path.join(fixtureDir, 'lbma.raw.json'), '123');
  fs.copyFileSync(FIXTURE('fred-DFII10.raw.json'), path.join(fixtureDir, 'fred-DFII10.raw.json'));
  fs.copyFileSync(FIXTURE('eastmoney-kline.raw.json'), path.join(fixtureDir, 'eastmoney-UDI.raw.json'));
  fs.copyFileSync(FIXTURE('cftc-deafut.raw.txt'), path.join(fixtureDir, 'cftc-current.raw.txt'));
  const r = runCli({
    script: 'collect-facts.js',
    args: ['--out', 'out/facts.json', '--history', 'hist', '--today', '2026-07-29', '--fixture-dir', fixtureDir],
  });
  // 进程应该完成并产出 facts.json(硬依赖满足,LBMA 是 soft)
  assert.equal(r.code, 0, `exit code should be 0; stderr: ${r.stderr}`);
  assert.ok(fs.existsSync(path.join(r.tmp, 'out', 'facts.json')), 'facts.json 应该被创建');
  // stderr 应包含 LBMA 诊断及其原因
  assert.ok(r.stderr.includes('LBMA 采集失败'), `stderr 应包含 LBMA 失败消息; actual: ${r.stderr}`);
  r.cleanup();
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

// —— A2:load* 的诊断不能是死代码——源模块内部吞异常时,诊断必须靠 status/error 字段浮出来 ——

test('T15(A2): loadFred 对"200 但空数组"给出诊断,而不是静默返回 ok', async () => {
  const logs = [];
  const orig = console.error;
  console.error = (msg) => logs.push(msg);
  try {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ observations: [] }) });
    const r = await C.loadFred({ fixtureDir: null, id: 'DFII10', today: '2026-07-29', apiKey: 'x', fetchImpl });
    assert.equal(r.status, 'missing');
    assert.ok(logs.some((m) => m.includes('FRED DFII10 采集失败')), `应输出诊断,实际: ${JSON.stringify(logs)}`);
  } finally { console.error = orig; }
});

test('T16(A2): loadFred 对 HTTP 403 给出带状态码的诊断(源从不外抛,靠 r.error 浮出原因)', async () => {
  const logs = [];
  const orig = console.error;
  console.error = (msg) => logs.push(msg);
  try {
    const fetchImpl = async () => ({ ok: false, status: 403 });
    const r = await C.loadFred({ fixtureDir: null, id: 'DFII10', today: '2026-07-29', apiKey: 'x', fetchImpl });
    assert.equal(r.status, 'missing');
    assert.ok(logs.some((m) => m.includes('HTTP 403')), `诊断应带失败原因,实际: ${JSON.stringify(logs)}`);
  } finally { console.error = orig; }
});

test('T17(A2): loadCalendar 逐 release 失败原因分别打诊断,不是笼统一条', async () => {
  const logs = [];
  const orig = console.error;
  console.error = (msg) => logs.push(msg);
  try {
    const fetchImpl = async (url) => {
      if (url.includes('release_id=50')) return { ok: false, status: 403 };
      return { ok: true, json: async () => ({ release_dates: [{ date: '2026-08-01' }] }) };
    };
    const r = await C.loadCalendar({ fixtureDir: null, releaseIds: { cpi: 10, nfp: 50 }, today: '2026-07-29', apiKey: 'x', fetchImpl });
    assert.equal(r.status, 'ok', 'cpi 成功,整体仍是 ok');
    assert.deepEqual(r.records.nfp, []);
    assert.ok(logs.some((m) => m.includes('nfp') && m.includes('403')), `应有 nfp 专属诊断,实际: ${JSON.stringify(logs)}`);
  } finally { console.error = orig; }
});

// —— A6:CFTC 历史回补部分年份失败不得被静默丢弃 ——

test('T18(A6): computeCftcSpecPctile 把历史回补部分年份失败透传到 failedYears', async () => {
  const { HistoryStore } = require('../references/scripts/lib/history-store');
  const tmp = freshTmp();
  const store = new HistoryStore(path.join(tmp, 'h'));
  const fetchCftcHistoryImpl = async () => ({ records: [], failed_years: [2023, 2024], status: 'missing' });
  const r = await C.computeCftcSpecPctile({
    store, fixtureDir: null, currentRecord: null, today: '2026-07-29', fetchCftcHistoryImpl,
  });
  assert.deepEqual(r.failedYears, [2023, 2024], 'failed_years 不得被 collect-facts 丢弃(A6)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T19(A6): 历史回补全部成功时 failedYears 为空数组', async () => {
  const { HistoryStore } = require('../references/scripts/lib/history-store');
  const tmp = freshTmp();
  const store = new HistoryStore(path.join(tmp, 'h'));
  const fetchCftcHistoryImpl = async () => ({ records: [], failed_years: [], status: 'missing' });
  const r = await C.computeCftcSpecPctile({
    store, fixtureDir: null, currentRecord: null, today: '2026-07-29', fetchCftcHistoryImpl,
  });
  assert.deepEqual(r.failedYears, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});
