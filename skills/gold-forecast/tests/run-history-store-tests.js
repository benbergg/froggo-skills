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
  const rows = h.readAll('lbma_pm_usd');
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
  assert.equal(h.readAll('fred_DTWEXBGS').length, 2, '修订须以新 vintage 并存');
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
  assert.deepEqual(h.readAll('x').map((r) => r.value), [1, 2]);
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
  assert.equal(h.readAll('x').length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T9: meta 可读写且持久', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  h.setMeta({ snapshot_at: '2026-07-29T00:00:00Z' });
  assert.equal(new HistoryStore(tmp).meta().snapshot_at, '2026-07-29T00:00:00Z');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// —— 并发写不污染已提交文件 ——
// 实测过的失败模式:固定 tmp 文件名下,A 写到一半、B 并发 open 同名 tmp(截断 A 的内容,
// 因为 'w' 是原地 O_TRUNC 而非换新 inode)→ B 写完 fsync rename 提交成功 →
// A 恢复后继续往同一 inode(此时已是刚提交的 filePath)写剩余数据,
// 污染 B 已原子提交的文件,且 A 自己的 rename 因 tmp 目录项已被 B 转走而抛 ENOENT。
// 破坏发生在 rename 之后,不是常规「半截文件」模式能防住的。

test('T10: 真实子进程并发写,已提交文件必须是某一方的完整内容而非拼接', async () => {
  const tmp = freshTmp();
  const f = path.join(tmp, 'concurrent.json');
  const atomicWritePath = require.resolve('../references/scripts/lib/atomic-write');
  const writerScript = path.join(tmp, 'writer.js');
  fs.writeFileSync(writerScript, `
    const { atomicWriteJSON } = require(${JSON.stringify(atomicWritePath)});
    const tag = process.argv[2];
    const target = process.argv[3];
    const payload = { tag, big: tag.repeat(150000) };
    for (let i = 0; i < 6; i++) atomicWriteJSON(target, payload);
  `);

  const { spawn } = require('node:child_process');
  const run = (tag) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [writerScript, tag, f]);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exit ${code}: ${stderr}`))));
  });

  await Promise.all([run('AAAA'), run('BBBB')]);

  const raw = fs.readFileSync(f, 'utf-8');
  const parsed = JSON.parse(raw); // 拼接出的畸形内容大概率连合法 JSON 都不是
  assert.ok(parsed.tag === 'AAAA' || parsed.tag === 'BBBB', `已提交内容 tag 异常: ${parsed.tag}`);
  assert.equal(parsed.big, parsed.tag.repeat(150000), '已提交内容被截断或与另一方拼接');

  const strays = fs.readdirSync(tmp).filter((name) => name.includes('.tmp.'));
  assert.equal(strays.length, 0, `不应残留 tmp 文件,实得 ${strays.join(', ')}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T11: 写入过程异常时清理 tmp,不留垃圾文件', () => {
  const tmp = freshTmp();
  const f = path.join(tmp, 'a.json');
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('模拟 fsync 失败'); };
  try {
    assert.throws(() => atomicWriteJSON(f, { x: 1 }), /模拟 fsync 失败/);
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.equal(fs.existsSync(f), false, '写入失败不应留下目标文件');
  const strays = fs.readdirSync(tmp).filter((name) => name.includes('.tmp.'));
  assert.equal(strays.length, 0, `写入失败后不应残留 tmp 文件,实得 ${strays.join(', ')}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// —— read() 前视过滤的三种绕过 ——
// 全部来自 collect-facts.js:208/309 的裸调用 store.read('cftc_gold') 实测,
// 属于「以为自己防住了前视,实际上没有」的隐蔽缺陷。

test('T12: 不传 availableOn(忘了传)必须响亮失败,不得静默返回全部', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  h.upsert('x', [{ observed_date: '2026-07-28', available_date: '2026-07-28', vintage: 'a', value: 1 }]);
  assert.throws(() => h.read('x'), /必须显式传/, '裸调用 read(series) 必须抛错而非默认读全部');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T13: availableOn 传非法日期字符串必须抛错,不得静默退化为不设防', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  h.upsert('x', [{ observed_date: '2026-07-28', available_date: '2026-07-28', vintage: 'a', value: 1 }]);
  assert.throws(() => h.read('x', { availableOn: 'not-a-date' }), /YYYY-MM-DD/);
  assert.throws(() => h.read('x', { availableOn: '' }), /YYYY-MM-DD/, '空字符串同样必须报错,不能退化成全部可见');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T14: 记录缺 available_date 时 read(availableOn) 必须响亮失败,不得静默放行', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  // 直接绕过 upsert 落一条缺字段的记录,模拟脏数据(上游漏填/迁移遗留)。
  h.upsert('x', [{ observed_date: '2026-12-31', vintage: 'a', value: 999 }]);
  assert.throws(
    () => h.read('x', { availableOn: '2026-07-05' }),
    /缺失 available_date/,
    '缺 available_date 时 undefined > x 恒 false,过滤会静默放行未来记录'
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T15: 显式 {availableOn: null} 与 readAll 等价,都是有意选择读全部', () => {
  const tmp = freshTmp();
  const h = new HistoryStore(tmp);
  h.upsert('x', [
    { observed_date: '2026-07-24', available_date: '2026-07-24', vintage: 'a', value: 1 },
    { observed_date: '2026-12-31', available_date: '2026-12-31', vintage: 'a', value: 2 },
  ]);
  const viaNull = h.read('x', { availableOn: null });
  const viaReadAll = h.readAll('x');
  assert.equal(viaNull.length, 2);
  assert.deepEqual(viaNull, viaReadAll, '两种显式「读全部」入口必须返回同样的结果');
  fs.rmSync(tmp, { recursive: true, force: true });
});
