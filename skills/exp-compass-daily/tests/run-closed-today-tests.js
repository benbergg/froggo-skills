'use strict';
// Unit tests for fetchClosedTodayStories(collect.js)。
//
// 2026-07-27:该函数原来在拉取失败时静默 `return []` 且不记 STATE.skipped,
// 于是日报"今日完成需求"整段无声归零 —— 读者看到的是"今天没完成任何需求"
// 这个**错误断言**,比不发日报更糟(exit 0 ≠ 数据取齐)。实跑当晚就命中过一次:
// `closedToday stories fetch failed (This operation was aborted (20))`。
//
// 锁定:失败重试一次;仍失败必须进 skipped(→ finalizeOutput 走 partial/fatal)。

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const {
  fetchClosedTodayStories,
  fetchTodayClosedBugs,
  fetchBugsInScope,
  STATE,
} = require('../references/scripts/collect.js');

beforeEach(() => {
  STATE.skipped = [];
  STATE.apiCalls = 0;
});

const okBody = (stories) => ({ ok: true, body: { stories } });

test('成功: 只返回 closedDate 为当日的需求', async () => {
  const state = { skipped: [] };
  const out = await fetchClosedTodayStories(95, '2026-07-27', {
    state,
    fetchFn: async () => okBody([
      { id: 1, closedDate: '2026-07-27 10:00:00' },
      { id: 2, closedDate: '2026-07-27 18:30:00' },
      { id: 3, closedDate: '2026-07-26 09:00:00' },
      { id: 4, closedDate: null },
    ]),
  });
  assert.deepEqual(out.map((s) => s.id), [1, 2]);
  assert.deepEqual(state.skipped, []);
});

test('首次失败、重试成功: 不记 skipped,数据正常返回', async () => {
  const state = { skipped: [] };
  let calls = 0;
  const out = await fetchClosedTodayStories(95, '2026-07-27', {
    state,
    fetchFn: async () => {
      calls++;
      if (calls === 1) return { ok: false, reason: 'This operation was aborted' };
      return okBody([{ id: 7, closedDate: '2026-07-27 11:00:00' }]);
    },
  });
  assert.equal(calls, 2, '失败后必须重试一次');
  assert.deepEqual(out.map((s) => s.id), [7]);
  assert.deepEqual(state.skipped, [], '重试成功不该留下 skipped');
});

test('REGRESSION: 两次都失败必须记 skipped(不能静默返回空)', async () => {
  const state = { skipped: [] };
  let calls = 0;
  const out = await fetchClosedTodayStories(95, '2026-07-27', {
    state,
    fetchFn: async () => {
      calls++;
      return { ok: false, reason: 'This operation was aborted' };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(out, []);
  assert.equal(state.skipped.length, 1,
    'REGRESSION: 静默返回 [] 会让日报断言"今日完成 0 个需求",必须记 skipped 让流程 fatal');
  assert.equal(state.skipped[0].path, '/products/*/stories');
  assert.match(state.skipped[0].reason, /aborted/);
});

// ---- 今日关闭 Bug:同一反模式的第二处 ------------------------------------

test('fetchTodayClosedBugs: 首次失败会重试一次', async () => {
  let calls = 0;
  const out = await fetchTodayClosedBugs(95, '2026-07-27', {
    fetchFn: async () => {
      calls++;
      if (calls === 1) return { ok: false, reason: 'aborted' };
      return { ok: true, body: { bugs: [{ id: 5, closedDate: '2026-07-27 12:00:00' }] } };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(out.map((b) => b.id), [5]);
});

test('fetchTodayClosedBugs: 两次都失败返回 null(交由调用方标 skipped)', async () => {
  const out = await fetchTodayClosedBugs(95, '2026-07-27', {
    fetchFn: async () => ({ ok: false, reason: 'aborted' }),
  });
  assert.equal(out, null);
});

test('REGRESSION: 今日关闭 Bug 拉取失败必须记 skipped,不能只静默返回 unclosed', async () => {
  const state = { skipped: [] };
  const out = await fetchBugsInScope(95, '2026-07-27', {
    state,
    paginateFn: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    closedTodayFn: async () => null,
  });
  assert.deepEqual(out.map((b) => b.id), [1, 2, 3], 'unclosed 仍应返回');
  assert.equal(state.skipped.length, 1,
    'REGRESSION: 2026-07-27 实跑 bugs 9→3、今日关闭的 6 条全丢却 exit 0');
  assert.equal(state.skipped[0].path, '/products/*/bugs');
});

test('今日关闭 Bug 正常时合并去重,不记 skipped', async () => {
  const state = { skipped: [] };
  const out = await fetchBugsInScope(95, '2026-07-27', {
    state,
    paginateFn: async () => [{ id: 1 }, { id: 2 }],
    closedTodayFn: async () => [{ id: 2 }, { id: 9 }],
  });
  assert.deepEqual(out.map((b) => b.id), [1, 2, 9]);
  assert.deepEqual(state.skipped, []);
});
