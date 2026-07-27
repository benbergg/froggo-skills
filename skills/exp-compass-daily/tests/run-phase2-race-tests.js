'use strict';
// Unit tests for collect.js 的 phase2 循环 fetchAllExecutionTasks。
//
// 2026-07-27 起直接测真实实现(此前是 spec mirror 副本,与 collect.js 会漂移)。
// 锁定的不变式:
//   1. 单个慢 execution 只丢自己,兄弟源保留(2026-05-13 per-exec race)
//   2. VOC-owned execution 先取,预算不够时先牺牲非 VOC
//   3. wall-clock 预算耗尽时停止投放新批次
//   4. 默认串行(并发 1)——2026-07-27 实证并发会把禅道同端点拖慢 2-4 倍
//   5. exec 超时自适应:按剩余预算/剩余 exec 数分配,clamp 到 [min,max]
//   6. 首轮失败的 execution 用剩余预算串行重试;重试成功必须抹掉 skipped 痕迹
//      (否则 finalizeOutput 仍会误判 fatal)

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const {
  fetchAllExecutionTasks,
  pickExecTimeoutMs,
  dropExecSkips,
  TASK_CONCURRENCY_DEFAULT,
  STATE,
} = require('../references/scripts/collect.js');

beforeEach(() => {
  STATE.skipped = [];
  STATE.apiCalls = 0;
});

// 每个测试用自己的 state,避免相互污染
const freshState = () => ({ skipped: [] });

// 造一个 fetchExecFn:slowIds 里的 exec 挂 delayMs,其余立即返回一条任务。
function makeFetchExec({ slowIds = [], delayMs = 200, failIds = [], okAfterFirstTry = [] } = {}) {
  const attempts = new Map();
  const fn = async (execId) => {
    const n = (attempts.get(Number(execId)) || 0) + 1;
    attempts.set(Number(execId), n);
    if (okAfterFirstTry.includes(Number(execId)) && n === 1) {
      await new Promise((r) => setTimeout(r, delayMs));
      return { ok: true, items: [{ id: `T_${execId}` }] };
    }
    if (slowIds.includes(Number(execId))) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    if (failIds.includes(Number(execId))) return { ok: false, items: [] };
    return { ok: true, items: [{ id: `T_${execId}` }] };
  };
  fn.attempts = attempts;
  return fn;
}

test('默认并发为 1(串行)——并发会把禅道同端点拖慢 2-4 倍', () => {
  assert.equal(TASK_CONCURRENCY_DEFAULT, 1);
});

test('INVARIANT: 慢 execution 只丢自己,4 个兄弟源保留', async () => {
  const state = freshState();
  const res = await fetchAllExecutionTasks(
    [{ id: 2028 }, { id: 2127 }, { id: 2121 }, { id: 2102 }, { id: 2085 }],
    '2026-07-27',
    {
      fetchExecFn: makeFetchExec({ slowIds: [2028], delayMs: 300 }),
      concurrency: 3,
      execTimeoutMinMs: 80,
      execTimeoutMaxMs: 80,
      state,
      traceFn: () => {},
      retryFailed: false,
    },
  );
  assert.equal(res.rawTasks.length, 4, '4 个兄弟源必须存活');
  assert.deepEqual(res.rawTasks.map((t) => t.id).sort(), ['T_2085', 'T_2102', 'T_2121', 'T_2127']);
  assert.deepEqual(state.skipped, [{
    path: '/executions/*/tasks', reason: 'exec-timeout', executions: [2028],
  }]);
});

test('INVARIANT: 多个慢源各自单独记录,不按批次汇总', async () => {
  const state = freshState();
  const res = await fetchAllExecutionTasks(
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
    '2026-07-27',
    {
      fetchExecFn: makeFetchExec({ slowIds: [2, 5], delayMs: 300 }),
      concurrency: 3,
      execTimeoutMinMs: 80,
      execTimeoutMaxMs: 80,
      state,
      traceFn: () => {},
      retryFailed: false,
    },
  );
  assert.equal(res.rawTasks.length, 4);
  assert.deepEqual(state.skipped.map((s) => s.executions), [[2], [5]]);
});

test('VOC-first: VOC-owned execution 先于非 VOC 被取', async () => {
  const order = [];
  const fetchExecFn = async (execId) => {
    order.push(Number(execId));
    return { ok: true, items: [{ id: `T_${execId}` }] };
  };
  await fetchAllExecutionTasks(
    [{ id: 100 }, { id: 200 }, { id: 300 }, { id: 400 }],
    '2026-07-27',
    {
      fetchExecFn,
      vocOwnedExecutionIds: new Set([200, 400]),
      concurrency: 2,
      state: freshState(),
      traceFn: () => {},
    },
  );
  assert.deepEqual(order.slice(0, 2).sort(), [200, 400], '前两个必须是 VOC');
  assert.deepEqual(order.slice(2).sort(), [100, 300]);
});

test('wall-clock 预算耗尽时停止投放新批次', async () => {
  const state = freshState();
  const clock = [0, 9_999_999];
  let idx = 0;
  const res = await fetchAllExecutionTasks(
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }],
    '2026-07-27',
    {
      fetchExecFn: makeFetchExec(),
      concurrency: 3,
      wallDeadlineMs: 1000,
      startMs: 0,
      nowFn: () => clock[Math.min(idx++, clock.length - 1)],
      state,
      traceFn: () => {},
    },
  );
  assert.equal(res.rawTasks.length, 3, '第一批 3 个在预算耗尽前完成');
  assert.equal(res.wallClockEarlyExit, true);
  assert.deepEqual(state.skipped, [{
    path: '/executions/*/tasks',
    reason: 'wall-clock-budget',
    remaining: 3,
    executions: [4, 5, 6],
  }]);
});

test('自适应超时: 剩余预算 / 剩余批次数,并 clamp 到 [min,max]', () => {
  // 预算充裕 → 取 max
  assert.equal(pickExecTimeoutMs(1_000_000, 2, 60_000, 240_000), 240_000);
  // 预算紧张 → 取 min(不会给出小到必然超时的值)
  assert.equal(pickExecTimeoutMs(10_000, 5, 60_000, 240_000), 60_000);
  // 中间值按均分
  assert.equal(pickExecTimeoutMs(400_000, 4, 60_000, 240_000), 100_000);
  // 剩余数为 0 不除零
  assert.equal(pickExecTimeoutMs(300_000, 0, 60_000, 240_000), 240_000);
});

test('重试轮: 首轮超时的 execution 第二次成功,数据补回且 skipped 痕迹清空', async () => {
  const state = freshState();
  // exec 7 第一次慢(超时),第二次快
  const fetchExecFn = makeFetchExec({ okAfterFirstTry: [7], delayMs: 300 });
  const res = await fetchAllExecutionTasks(
    [{ id: 7 }, { id: 8 }],
    '2026-07-27',
    {
      fetchExecFn,
      concurrency: 1,
      execTimeoutMinMs: 80,
      execTimeoutMaxMs: 80,
      state,
      traceFn: () => {},
    },
  );
  assert.deepEqual(res.retriedOk, [7], 'exec 7 应在重试轮成功');
  assert.deepEqual(res.rawTasks.map((t) => t.id).sort(), ['T_7', 'T_8']);
  assert.deepEqual(state.skipped, [], '重试成功后不能残留 skipped,否则 finalizeOutput 误判 fatal');
});

test('重试轮: 第二次仍失败则保留 skipped(不掩盖真故障)', async () => {
  const state = freshState();
  const fetchExecFn = makeFetchExec({ slowIds: [9], delayMs: 300 });
  const res = await fetchAllExecutionTasks([{ id: 9 }], '2026-07-27', {
    fetchExecFn,
    concurrency: 1,
    execTimeoutMinMs: 80,
    execTimeoutMaxMs: 80,
    state,
    traceFn: () => {},
  });
  assert.deepEqual(res.retriedOk, []);
  assert.equal(fetchExecFn.attempts.get(9), 2, '应恰好尝试 2 次');
  assert.deepEqual(state.skipped, [{
    path: '/executions/*/tasks', reason: 'exec-timeout', executions: [9],
  }]);
});

test('重试轮: 预算不足时不重试,并保留 skipped', async () => {
  const state = freshState();
  const fetchExecFn = makeFetchExec({ slowIds: [11], delayMs: 200 });
  let calls = 0;
  const res = await fetchAllExecutionTasks([{ id: 11 }], '2026-07-27', {
    fetchExecFn,
    concurrency: 1,
    execTimeoutMinMs: 80,
    execTimeoutMaxMs: 80,
    wallDeadlineMs: 500,
    startMs: 0,
    // 第一次(循环入口)返回 0,之后返回 480 → 剩余 20ms < min,不重试
    nowFn: () => (calls++ === 0 ? 0 : 480),
    state,
    traceFn: () => {},
  });
  assert.deepEqual(res.retriedOk, []);
  assert.equal(fetchExecFn.attempts.get(11), 1, '预算不足时不应发起第二次');
  assert.equal(state.skipped.length, 1);
});

test('dropExecSkips 清掉该 exec 的 page 级与汇总级两种记录,不误伤别的 exec', () => {
  const state = {
    skipped: [
      { path: '/executions/*/tasks', page: 1, queryParam: 'order=openedDate_desc', execId: 2028, reason: 'AbortError' },
      { path: '/executions/*/tasks', reason: 'exec-timeout', executions: [2028] },
      { path: '/executions/*/tasks', reason: 'exec-timeout', executions: [3436] },
      { path: '/products/*/bugs', page: 2, reason: 'http' },
      { path: '/executions/*/tasks', reason: 'wall-clock-budget', remaining: 2, executions: [2028, 3436] },
    ],
  };
  dropExecSkips(state, 2028);
  assert.deepEqual(state.skipped, [
    { path: '/executions/*/tasks', reason: 'exec-timeout', executions: [3436] },
    { path: '/products/*/bugs', page: 2, reason: 'http' },
    { path: '/executions/*/tasks', reason: 'wall-clock-budget', remaining: 2, executions: [2028, 3436] },
  ], '多 exec 的 wall-clock 汇总条目不能被单 exec 的成功抹掉');
});

test('REGRESSION CANARY: 整批 race 若被还原,此测试应失败', async () => {
  const state = freshState();
  const res = await fetchAllExecutionTasks(
    [{ id: 2028 }, { id: 2127 }, { id: 2121 }, { id: 2102 }, { id: 2085 }],
    '2026-07-27',
    {
      fetchExecFn: makeFetchExec({ slowIds: [2028], delayMs: 300 }),
      concurrency: 5,
      execTimeoutMinMs: 80,
      execTimeoutMaxMs: 80,
      state,
      traceFn: () => {},
      retryFailed: false,
    },
  );
  assert.notEqual(res.rawTasks.length, 0, 'REGRESSION: rawTasks 为空说明整批 race 回归了');
  assert.equal(res.rawTasks.length, 4);
});
