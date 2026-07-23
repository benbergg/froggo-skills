'use strict';
// Unit tests for fetchExecutionTasksScoped in collect.js.
//
// These tests inject a mock fetchFn to avoid real Zentao traffic. They lock
// in the 2026-05-13 "over-fetch → scoped multi-order fetch" redesign that
// replaced ztPaginate('/executions/{id}/tasks') with three parallel
// order=...desc queries + client-side lookback early-exit.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Stub env before require — collect.js requires ZENTAO_* only inside main(),
// but ztFetch closure pulls baseUrl from STATE. We never call ztFetch in tests
// (we inject fetchFn), but stub anyway in case future helpers do.
process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const { fetchExecutionTasksScoped, STATE } = require('../references/scripts/collect.js');

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

test('INVARIANT: 1576-row historical exec collapses to scoped union (<100)', async () => {
  // Synthesizes exec 2028 baseline. Each order=...desc page1 returns the
  // top of its sort window; we expect early-exit on the first row outside
  // the 30-day lookback (default).
  const today = '2026-05-13';
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': {
      ok: true,
      body: {
        tasks: [
          T(44013, { openedDate: '2026-05-13 09:00', storyID: 21311 }),
          T(44000, { openedDate: '2026-05-10 09:00', storyID: 21311 }),
          T(42500, { openedDate: '2026-03-01 09:00', storyID: 21311 }), // < threshold
        ],
      },
    },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': {
      ok: true,
      body: {
        tasks: [
          T(43999, { finishedDate: '2026-05-12 17:00' }),
          T(43000, { finishedDate: null }),                 // tail null → break
          T(42999, { finishedDate: '2026-02-01 17:00' }),   // unreachable
        ],
      },
    },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': {
      ok: true,
      body: { tasks: [T(44013, { lastEditedDate: '2026-05-13 16:00' })] },
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

test('UNHAPPY: one of three queries fails — other two still contribute (partial success)', async () => {
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': {
      ok: false, reason: 'network-timeout',
    },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': {
      ok: true,
      body: { tasks: [T(43999, { finishedDate: '2026-05-13 17:00' })] },
    },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': {
      ok: true,
      body: { tasks: [T(44013, { lastEditedDate: '2026-05-13 16:00' })] },
    },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-13', { fetchFn });
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
  const result = await fetchExecutionTasksScoped(2028, '2026-05-13', { fetchFn });
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
          T(1, { finishedDate: '2026-05-13 17:00' }),
          T(2, { finishedDate: null }),                // break here
          T(3, { finishedDate: '2026-05-12 17:00' }),  // never collected
        ],
      },
    },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-13', { fetchFn });
  assert.deepEqual(result.items.map((t) => t.id), [1]);
});

test('openedDate < threshold: stops scanning at first row outside lookback (30d default)', async () => {
  // date 2026-05-13 → threshold 2026-04-13
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': {
      ok: true,
      body: {
        tasks: [
          T(1, { openedDate: '2026-05-13' }),  // today — keep
          T(2, { openedDate: '2026-04-15' }),  // within window — keep
          T(3, { openedDate: '2026-04-10' }),  // < threshold — break
          T(4, { openedDate: '2026-03-01' }),  // unreachable
        ],
      },
    },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-13', { fetchFn });
  assert.deepEqual(result.items.map((t) => t.id).sort(), [1, 2]);
});

test('dedup: same task id appearing in all three queries collapses to one', async () => {
  const shared = T(44013, {
    openedDate: '2026-05-13 09:00',
    finishedDate: '2026-05-13 17:00',
    lastEditedDate: '2026-05-13 17:30',
  });
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1':    { ok: true, body: { tasks: [shared] } },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1':  { ok: true, body: { tasks: [shared] } },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [shared] } },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-13', { fetchFn });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 44013);
});

test('REGRESSION CANARY: today\'s exec=2028 active task T44013 survives', async () => {
  // The exact scenario that caused the 3 cron翻车: T44013 (today's only
  // active VOC task, storyID=21311) lives on exec 2028 mixed with 1575
  // closed historical tasks. Pre-fix: ztPaginate fetches 16 pages × ~14s
  // = 220s → exec-timeout drops the entire exec → T44013 missing.
  // Post-fix: order=openedDate_desc page1 captures today's row in <10s.
  const T44013 = T(44013, {
    openedDate: '2026-05-13 09:00:00',
    finishedDate: '2026-05-13 17:00:00',
    storyID: 21311,
    execution: 2028,
  });
  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': {
      ok: true,
      body: { tasks: [T44013, T(40000, { openedDate: '2024-08-01' }) /* < threshold, break */] },
    },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': {
      ok: true, body: { tasks: [T44013] },
    },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': {
      ok: true, body: { tasks: [T44013] },
    },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-13', { fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 44013);
  assert.equal(result.items[0].storyID, 21311,
    'storyID must be preserved — downstream tasksAttachedToStory filter depends on it');
});

// ---------------------------------------------------------------------------
// 2026-07-23 adaptive single-call 测试组
//
// 线上实证(2026-07-23 晚三连败):b7e92e6 executions 取齐后 phase2 要对
// ~91 个 execution 各发 3 次排序查询(~280 调用),其中 ~85 个是无近期
// 活动的陈年迭代,晚间禅道单调用 3-4s 时必撞 900s 硬超时。
// 修复:先发 1 次 lastEditedDate_desc page1 探针,total 为数字且首页
// 已取齐(含 total=0)则单调用+客户端三字段过滤;否则回退 3 腿路径并
// 复用探针为 lastEditedDate 腿 page1。
// 注意:不允许按 execution.status/end 上游过滤——exec 2028 实测
// status=doing、end=2024-08-31,两个字段都会误杀最核心的班牛 sprint。
// ---------------------------------------------------------------------------

function makeCountingFetch(responses) {
  const inner = makeMockFetch(responses);
  const fn = async (url) => {
    fn.calls.push(url);
    return inner(url);
  };
  fn.calls = [];
  return fn;
}

test('ADAPTIVE: 空迭代 total=0 → 单调用返回空', async () => {
  const fetchFn = makeCountingFetch({
    '/executions/3100/tasks?order=lastEditedDate_desc&limit=100&page=1': {
      ok: true,
      body: { total: 0, tasks: [] },
    },
  });
  const result = await fetchExecutionTasksScoped(3100, '2026-07-23', { fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 0);
  assert.equal(fetchFn.calls.length, 1,
    `empty exec must cost exactly 1 call, got ${fetchFn.calls.length}: ${fetchFn.calls}`);
});

test('ADAPTIVE: 小迭代首页取齐 → 单调用 + 客户端三字段过滤', async () => {
  // threshold = 2026-06-23 (30d before 2026-07-23)
  const fetchFn = makeCountingFetch({
    '/executions/3456/tasks?order=lastEditedDate_desc&limit=100&page=1': {
      ok: true,
      body: {
        total: 5,
        tasks: [
          T(1, { lastEditedDate: '2026-07-23 10:00' }),            // in-window (edited)
          T(2, { openedDate: '2026-07-01 09:00' }),                // in-window (opened, never edited)
          // 下面这条:null finishedDate 行之后仍有 in-window 行——旧 leg
          // 逻辑(skipNullEarly)会把它漏掉,客户端全量过滤必须保留
          T(3, { finishedDate: null }),                            // out (all fields null/out)
          T(4, { finishedDate: '2026-07-20 17:00' }),              // in-window (finished)
          T(5, { openedDate: '2026-01-01', lastEditedDate: '2026-02-01' }), // out
        ],
      },
    },
  });
  const result = await fetchExecutionTasksScoped(3456, '2026-07-23', { fetchFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((t) => t.id).sort(), [1, 2, 4],
    `client-side 3-field filter mismatch: ${result.items.map((t) => t.id)}`);
  assert.equal(fetchFn.calls.length, 1,
    `small exec must cost exactly 1 call, got ${fetchFn.calls.length}`);
});

test('ADAPTIVE: 大迭代 total>首页 → 回退 3 腿,探针复用为 lastEditedDate page1(共 3 调用)', async () => {
  const probeRows = [T(44013, { lastEditedDate: '2026-07-23 16:00' })];
  const fetchFn = makeCountingFetch({
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': {
      ok: true,
      body: { total: 1576, tasks: probeRows },
    },
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': {
      ok: true,
      body: { total: 1576, tasks: [T(44014, { openedDate: '2026-07-23 09:00' }), T(40000, { openedDate: '2024-08-01' })] },
    },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': {
      ok: true,
      body: { total: 1576, tasks: [T(44015, { finishedDate: '2026-07-22 17:00' })] },
    },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-07-23', { fetchFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((t) => t.id).sort(), [44013, 44014, 44015]);
  assert.equal(fetchFn.calls.length, 3,
    `big exec must reuse probe as lastEditedDate page1 (3 calls total), got ${fetchFn.calls.length}: ${fetchFn.calls}`);
  const lastEditedCalls = fetchFn.calls.filter((u) => u.includes('lastEditedDate'));
  assert.equal(lastEditedCalls.length, 1, 'lastEditedDate page1 must not be fetched twice');
});

test('ADAPTIVE-DEFENSIVE: 响应无 total → 回退 3 腿路径(探针复用,共 3 调用)', async () => {
  const fetchFn = makeCountingFetch({
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': {
      ok: true,
      body: { tasks: [T(44013, { lastEditedDate: '2026-07-23 16:00' })] }, // no total
    },
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': {
      ok: true, body: { tasks: [] },
    },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': {
      ok: true, body: { tasks: [] },
    },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-07-23', { fetchFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((t) => t.id), [44013]);
  assert.equal(fetchFn.calls.length, 3, `no-total fallback must cost 3 calls, got ${fetchFn.calls.length}`);
});

test('multi-page pagination: page=2 still respects threshold + maxPages cap', async () => {
  // Exec with 150 within-window tasks. Page 1 has 100 (all in scope, none < threshold),
  // page 2 has 50 then hits older. Should pull both pages.
  const page1 = [];
  for (let i = 0; i < 100; i++) {
    page1.push(T(50000 + i, { openedDate: '2026-05-13' }));
  }
  const page2 = [];
  for (let i = 0; i < 50; i++) {
    page2.push(T(40000 + i, { openedDate: '2026-04-20' })); // in-window
  }
  page2.push(T(39999, { openedDate: '2026-03-01' })); // < threshold

  const fetchFn = makeMockFetch({
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=1': { ok: true, body: { tasks: page1 } },
    '/executions/2028/tasks?order=openedDate_desc&limit=100&page=2': { ok: true, body: { tasks: page2 } },
    '/executions/2028/tasks?order=finishedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
    '/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1': { ok: true, body: { tasks: [] } },
  });
  const result = await fetchExecutionTasksScoped(2028, '2026-05-13', { fetchFn });
  assert.equal(result.items.length, 150, `expected page1 + page2 in-scope rows, got ${result.items.length}`);
});
