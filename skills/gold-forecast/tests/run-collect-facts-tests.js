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
