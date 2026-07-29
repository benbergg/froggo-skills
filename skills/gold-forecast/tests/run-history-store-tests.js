'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshTmp } = require('./helpers');
const { atomicWriteJSON } = require('../references/scripts/lib/atomic-write');
const { HistoryStore } = require('../references/scripts/lib/history-store');

test('T1: 原子写落盘且内容正确', () => {
  const tmp = freshTmp();
  const f = path.join(tmp, 'a.json');
  atomicWriteJSON(f, { x: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf-8')), { x: 1 });
  assert.equal(fs.existsSync(f + '.tmp'), false, '临时文件必须已被 rename 掉');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T2: 覆盖写会把旧版移入 versions/', () => {
  const tmp = freshTmp();
  const f = path.join(tmp, 'a.json');
  atomicWriteJSON(f, { v: 1 });
  atomicWriteJSON(f, { v: 2 });
  const versions = fs.readdirSync(path.join(tmp, 'versions'));
  assert.equal(versions.length, 1, '应保留一份旧版');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf-8')), { v: 2 });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T3: 版本滚动上限生效', () => {
  const tmp = freshTmp();
  const f = path.join(tmp, 'a.json');
  for (let i = 0; i < 6; i++) atomicWriteJSON(f, { v: i }, { keepVersions: 3 });
  const versions = fs.readdirSync(path.join(tmp, 'versions'));
  assert.equal(versions.length, 3, `应只保留 3 份,实得 ${versions.length}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// —— history store ——
// 这一组是 A-3「单一数据路径」的地基:同日重跑若追加出第二条,
// 会直接污染 σ_d 与 p0_N,而且不报错。

test('T4: upsert 同主键不产生重复行', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  const rec = { observed_date: '2026-07-28', available_date: '2026-07-28', vintage: '2026-07-28', value: 4022.2 };
  h.upsert('lbma_pm_usd', [rec]);
  const r2 = h.upsert('lbma_pm_usd', [{ ...rec, value: 4022.5 }]);
  assert.equal(r2.inserted, 0);
  assert.equal(r2.updated, 1);
  const rows = h.read('lbma_pm_usd');
  assert.equal(rows.length, 1, '同主键必须覆盖而非追加');
  assert.equal(rows[0].value, 4022.5);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T5: 不同 vintage 视为不同记录,均保留', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  h.upsert('fred_DTWEXBGS', [
    { observed_date: '2026-07-24', available_date: '2026-07-27', vintage: '2026-07-27', value: 120.71 },
    { observed_date: '2026-07-24', available_date: '2026-07-30', vintage: '2026-07-30', value: 120.85 },
  ]);
  assert.equal(h.read('fred_DTWEXBGS').length, 2, '修订须以新 vintage 并存');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T6: availableOn 只返回当时可见的版本(防前视偏差)', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  h.upsert('fred_DTWEXBGS', [
    { observed_date: '2026-07-24', available_date: '2026-07-27', vintage: '2026-07-27', value: 120.71 },
    { observed_date: '2026-07-24', available_date: '2026-07-30', vintage: '2026-07-30', value: 120.85 },
  ]);
  const asOf28 = h.read('fred_DTWEXBGS', { availableOn: '2026-07-28' });
  assert.equal(asOf28.length, 1);
  assert.equal(asOf28[0].value, 120.71, '7-28 当天只可能看到 7-27 那一版');

  const asOf31 = h.read('fred_DTWEXBGS', { availableOn: '2026-07-31' });
  assert.equal(asOf31.length, 1, '同一 observed_date 只返回一条');
  assert.equal(asOf31[0].value, 120.85, '7-31 应看到修订后的版本');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T7: read 按 observed_date 升序', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  h.upsert('x', [
    { observed_date: '2026-07-28', available_date: '2026-07-28', vintage: 'a', value: 2 },
    { observed_date: '2026-07-24', available_date: '2026-07-24', vintage: 'a', value: 1 },
  ]);
  assert.deepEqual(h.read('x').map((r) => r.value), [1, 2]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T8: remove 按主键删除,供事务回滚使用', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  h.upsert('x', [
    { observed_date: '2026-07-28', available_date: '2026-07-28', vintage: 'a', value: 1 },
    { observed_date: '2026-07-27', available_date: '2026-07-27', vintage: 'a', value: 2 },
  ]);
  const n = h.remove('x', [{ observed_date: '2026-07-28', vintage: 'a' }]);
  assert.equal(n, 1);
  assert.equal(h.read('x').length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T9: meta 可读写且持久', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  h.setMeta({ snapshot_at: '2026-07-29T00:00:00Z' });
  assert.equal(new HistoryStore(tmp).meta().snapshot_at, '2026-07-29T00:00:00Z');
  fs.rmSync(tmp, { recursive: true, force: true });
});
