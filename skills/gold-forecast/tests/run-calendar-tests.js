'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURE, freshTmp, runCli } = require('./helpers');
const { parseLbma } = require('../references/scripts/sources/lbma-gold-pm');
const cal = require('../references/scripts/lib/trading-calendar');

const RAW = JSON.parse(fs.readFileSync(FIXTURE('lbma-gold-pm.raw.json'), 'utf-8'));

test('T1: parseLbma 取 USD 列并丢弃空值行', () => {
  const rows = parseLbma([
    { d: '2026-07-27', v: [4075, 3060.73, 3582.33] },
    { d: '2026-07-28', v: [4022.2, 3023.89, 3537.12] },
    { d: '1968-04-01', v: [null, 15.68, null] },
  ]);
  assert.equal(rows.length, 2, 'USD 为 null 的行必须丢弃');
  assert.equal(rows[1].value, 4022.2);
  assert.equal(rows[1].observed_date, '2026-07-28');
});

test('T2: 定盘价当日即可得,observed 与 available 同日', () => {
  const [r] = parseLbma([{ d: '2026-07-28', v: [4022.2, 0, 0] }]);
  assert.equal(r.available_date, r.observed_date, '定盘价无发布滞后');
  assert.equal(r.vintage, r.observed_date);
});

test('T3: 真实夹具解析出连续交易日,且周末缺失', () => {
  const rows = parseLbma(RAW);
  const dates = new Set(rows.map((r) => r.observed_date));
  assert.ok(dates.has('2026-07-24'), '周五应有定盘');
  assert.ok(dates.has('2026-07-27'), '周一应有定盘');
  assert.equal(dates.has('2026-07-25'), false, '周六不应有定盘');
  assert.equal(dates.has('2026-07-26'), false, '周日不应有定盘');
});

// —— 交易日历 ——
// 这一组防的是设计 5.3 点名的坑:T+1 若按自然日算,周五会指向周六,
// 该预测永远不结算、悄悄从统计消失,而消失的正是周末前的高不确定日。

const C = ['2026-07-22', '2026-07-23', '2026-07-24', '2026-07-27', '2026-07-28', '2026-07-29'];

test('T4: nthSession 跳过周末', () => {
  assert.equal(cal.nthSession(C, '2026-07-24', 1), '2026-07-27', '周五的 T+1 是下周一,不是周六');
});

test('T5: nthSession 多步', () => {
  assert.equal(cal.nthSession(C, '2026-07-22', 3), '2026-07-27');
});

test('T6: nthSession 越界返回 null 而非抛错', () => {
  assert.equal(cal.nthSession(C, '2026-07-29', 5), null);
});

test('T7: fromDate 不在日历内时,从其后第一个交易日起算', () => {
  assert.equal(cal.nthSession(C, '2026-07-25', 1), '2026-07-28',
    '基准日落在非交易日时,T+1 应为其后第 1 个交易日之后的那个');
});

test('T8: isSession 判定', () => {
  assert.equal(cal.isSession(C, '2026-07-27'), true);
  assert.equal(cal.isSession(C, '2026-07-25'), false);
});

test('T9: sessionsBetween 计交易日间隔', () => {
  assert.equal(cal.sessionsBetween(C, '2026-07-24', '2026-07-28'), 2);
});

// —— collect-settlement CLI ——

test('T10: CLI 写出 settlement-price.json 且新鲜度通过', () => {
  const r = runCli({
    script: 'collect-settlement.js',
    args: ['--out', 'out.json', '--history', 'h', '--fixture', FIXTURE('lbma-gold-pm.raw.json'),
           '--expect-session', '2026-07-28'],
  });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(path.join(r.tmp, 'out.json'), 'utf-8'));
  assert.equal(out.freshness_ok, true);
  assert.equal(out.latest.date, '2026-07-28');
  assert.equal(out.latest.value, 4022.2);
  assert.ok(Array.isArray(out.calendar_tail) && out.calendar_tail.length >= 5);
  r.cleanup();
});

test('T11: 数据陈旧时 exit 4 且不写产物', () => {
  // 站点可能 HTTP 200 却返回过期数据 —— 只检查请求成功会拿旧价结算。
  const r = runCli({
    script: 'collect-settlement.js',
    args: ['--out', 'out.json', '--history', 'h', '--fixture', FIXTURE('lbma-gold-pm.raw.json'),
           '--expect-session', '2026-08-15'],
  });
  assert.equal(r.code, 4, `陈旧数据必须 exit 4,实得 ${r.code}`);
  assert.equal(fs.existsSync(path.join(r.tmp, 'out.json')), false, '失败时不得留下产物');
  r.cleanup();
});

test('T12: CLI 把定盘价写入历史库', () => {
  const r = runCli({
    script: 'collect-settlement.js',
    args: ['--out', 'out.json', '--history', 'h', '--fixture', FIXTURE('lbma-gold-pm.raw.json'),
           '--expect-session', '2026-07-28'],
  });
  assert.equal(r.code, 0);
  const jsonl = fs.readFileSync(path.join(r.tmp, 'h', 'lbma_pm_usd.jsonl'), 'utf-8');
  assert.ok(jsonl.includes('"observed_date":"2026-07-28"'));
  r.cleanup();
});

test('T13: settlement-price.json 必须带 history,否则下游 T+5/T+20 永远按目标日结算不到', () => {
  const r = runCli({
    script: 'collect-settlement.js',
    args: ['--out', 'out.json', '--history', 'h', '--fixture', FIXTURE('lbma-gold-pm.raw.json'),
           '--expect-session', '2026-07-28'],
  });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(path.join(r.tmp, 'out.json'), 'utf-8'));
  assert.ok(Array.isArray(out.history) && out.history.length >= 5, 'history 必须是数组且长度 ≥ 5');
  for (const row of out.history) {
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/, 'history[].date 须为 YYYY-MM-DD');
    assert.equal(typeof row.value, 'number', 'history[].value 须为 number');
  }
  const last = out.history[out.history.length - 1];
  assert.deepEqual(last, out.latest, 'history 最后一条须与 latest 一致');
  const dates = out.history.map((r2) => r2.date);
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted, 'history 须按 date 升序');
  r.cleanup();
});
