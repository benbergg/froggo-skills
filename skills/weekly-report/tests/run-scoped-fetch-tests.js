'use strict';
// Unit tests for fetchExecutionTasksScoped in collect-weekly.js.
//
// Pinned 2026-05-17 after porting the scoped multi-order fetch pattern from
// exp-compass-daily (commit abf74f3). Same shape as
// exp-compass-daily/tests/run-scoped-fetch-tests.js, but the default
// lookbackDays is 14 (weekly window + 1-week buffer for lastEditedDate stale
// entries) instead of 30, to keep the wall-clock cost reasonable when running
// across all 2228 view.sprints without the doing-only prefilter.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const { fetchExecutionTasksScoped, STATE } = require('../references/scripts/collect-weekly.js');

beforeEach(() => {
  STATE.skipped = [];
  STATE.apiCalls = 0;
});

const T = (id, fields = {}) => ({
  id,
  openedDate: null,
  finishedDate: null,
  lastEditedDate: null,
  ...fields,
});

function makeMockFetch(responses) {
  return async (url) => {
    if (Object.prototype.hasOwnProperty.call(responses, url)) {
      return responses[url];
    }
    return { ok: false, reason: `no-mock:${url}` };
  };
}

test('INVARIANT: historical exec collapses to scoped union under 14d lookback', async () => {
  const today = '2026-05-17';
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': {
      ok: true,
      body: {
        tasks: [
          T(44013, { openedDate: '2026-05-15 09:00' }),
          T(44000, { openedDate: '2026-05-10 09:00' }),
          T(42500, { openedDate: '2026-04-01 09:00' }), // < threshold (2026-05-03)
        ],
      },
    },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': {
      ok: true,
      body: {
        tasks: [
          T(43999, { finishedDate: '2026-05-12 17:00' }),
          T(43000, { finishedDate: null }),
          T(42999, { finishedDate: '2026-02-01 17:00' }),
        ],
      },
    },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': {
      ok: true,
      body: { tasks: [T(44013, { lastEditedDate: '2026-05-16 16:00' })] },
    },
  });

  const result = await fetchExecutionTasksScoped(2028, today, { fetchFn });
  assert.equal(result.ok, true);
  assert.ok(result.items.length < 100,
    `over-fetch regression: expected <100, got ${result.items.length}`);
  const ids = result.items.map((t) => t.id).sort();
  assert.deepEqual(ids, [43999, 44000, 44013],
    `expected scoped union, got ${ids}`);
});

test('UNHAPPY: one of three queries fails — other two still contribute', async () => {
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': {
      ok: false, reason: 'network-timeout',
    },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': {
      ok: true,
      body: { tasks: [T(43999, { finishedDate: '2026-05-15 17:00' })] },
    },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': {
      ok: true,
      body: { tasks: [T(44013, { lastEditedDate: '2026-05-16 16:00' })] },
    },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-17', { fetchFn });
  assert.equal(result.ok, true, 'partial success should still be ok:true');
  const ids = result.items.map((t) => t.id).sort();
  assert.deepEqual(ids, [43999, 44013]);
  assert.ok(
    STATE.skipped.some((s) => s.reason === 'network-timeout' && s.queryParam === 'order=openedDate_desc'),
    `STATE.skipped should record failed openedDate query: ${JSON.stringify(STATE.skipped)}`,
  );
});

test('UNHAPPY: all three queries fail → ok:false, empty items, 3 skipped entries', async () => {
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': { ok: false, reason: 'timeout' },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': { ok: false, reason: 'timeout' },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': { ok: false, reason: 'timeout' },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-17', { fetchFn });
  assert.equal(result.ok, false);
  assert.equal(result.items.length, 0);
  assert.equal(STATE.skipped.length, 3);
});

test('finishedDate null-cluster early-exit: stops at first null row', async () => {
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': {
      ok: true,
      body: {
        tasks: [
          T(1, { finishedDate: '2026-05-15 17:00' }),
          T(2, { finishedDate: null }),
          T(3, { finishedDate: '2026-05-12 17:00' }),
        ],
      },
    },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-17', { fetchFn });
  assert.deepEqual(result.items.map((t) => t.id), [1]);
});

test('openedDate < threshold: stops at first row outside 14d lookback', async () => {
  // date 2026-05-17 → threshold 2026-05-03
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': {
      ok: true,
      body: {
        tasks: [
          T(1, { openedDate: '2026-05-15' }),  // in-window
          T(2, { openedDate: '2026-05-05' }),  // in-window
          T(3, { openedDate: '2026-04-30' }),  // < threshold — break
          T(4, { openedDate: '2026-03-01' }),  // unreachable
        ],
      },
    },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-17', { fetchFn });
  assert.deepEqual(result.items.map((t) => t.id).sort(), [1, 2]);
});

test('dedup: same task id appearing in all three queries collapses to one', async () => {
  const shared = T(44013, {
    openedDate: '2026-05-15 09:00',
    finishedDate: '2026-05-15 17:00',
    lastEditedDate: '2026-05-15 17:30',
  });
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1':    { ok: true, body: { tasks: [shared] } },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1':  { ok: true, body: { tasks: [shared] } },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [shared] } },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-17', { fetchFn });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 44013);
});

test('multi-page pagination: page=2 still respects threshold + maxPages cap', async () => {
  const page1 = [];
  for (let i = 0; i < 100; i++) {
    page1.push(T(50000 + i, { openedDate: '2026-05-15' }));
  }
  const page2 = [];
  for (let i = 0; i < 50; i++) {
    page2.push(T(40000 + i, { openedDate: '2026-05-04' })); // in-window (threshold = 2026-05-03)
  }
  page2.push(T(39999, { openedDate: '2026-04-01' })); // < threshold

  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': { ok: true, body: { tasks: page1 } },
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=2': { ok: true, body: { tasks: page2 } },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-17', { fetchFn });
  assert.equal(result.items.length, 150, `expected page1 + page2 in-scope rows, got ${result.items.length}`);
});

test('REGRESSION CANARY: 14d lookback covers full ISO week + 1w buffer', async () => {
  // Cron commonly runs on Saturday (wk_end - 1 = day 6); the scoped fetch
  // base date is wk_end - 1 day. A task assigned on Monday (wk_start) and
  // never edited again must still be reachable. With lookback=14, Monday is
  // at offset -5 from Saturday, well within the window.
  //
  // This canary also locks the choice of 14 over 7 — a 7d lookback would
  // miss tasks edited last week but rolled into this week's progress section.
  const today = '2026-05-16'; // a Saturday → wk_end - 1
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': {
      ok: true,
      body: {
        tasks: [
          T(1, { openedDate: '2026-05-11' }),  // wk_start (Mon) — in 14d window
          T(2, { openedDate: '2026-05-05' }),  // last week Tue — in 14d window
          T(3, { openedDate: '2026-05-01' }),  // 15d back — out
        ],
      },
    },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
  });
  const result = await fetchExecutionTasksScoped(2028, today, { fetchFn });
  const ids = result.items.map((t) => t.id).sort();
  assert.deepEqual(ids, [1, 2], `expected 14d lookback to capture wk_start, got ${ids}`);
});
