'use strict';
// Spec tests for the per-execution race phase2 batch loop in collect.js
// (~line 783-845). These tests lock in the 2026-05-13 fix invariants:
//
//   1. One slow execution only drops its own data; sibling tasks survive.
//   2. VOC-owned executions are drained before non-VOC ones.
//   3. Wall-clock budget exhaustion still stops enqueuing new batches.
//
// IMPORTANT: phase2BatchFetch below is a *spec mirror* of collect.js's
// phase2 batch loop. If you refactor that loop in collect.js (e.g. switch
// concurrency model, change timeout semantics, drop VOC-first sort), you
// MUST update this spec or replace it with an end-to-end test that spawns
// collect.js against a mock Zentao server. Out-of-sync spec is worse than
// no spec.

const { test } = require('node:test');
const assert = require('node:assert/strict');

async function phase2BatchFetch({
  allExecs,
  paginateFn,
  vocOwnedExecutionIds = new Set(),
  concurrency = 3,
  execTimeoutMs = 90_000,
  wallDeadlineMs = Infinity,
  startTimeMs = 0,
  nowFn = Date.now,
  traceFn = () => {},
}) {
  const sorted = [...allExecs].sort((a, b) => {
    const av = vocOwnedExecutionIds.has(Number(a.id)) ? 0 : 1;
    const bv = vocOwnedExecutionIds.has(Number(b.id)) ? 0 : 1;
    return av - bv;
  });
  const EXEC_TIMEOUT_SENTINEL = Symbol('exec-timeout');
  const rawTasks = [];
  const skipped = [];
  let wallClockEarlyExit = false;
  for (let i = 0; i < sorted.length; i += concurrency) {
    const elapsedMs = nowFn() - startTimeMs;
    if (elapsedMs > wallDeadlineMs) {
      const remaining = sorted.length - i;
      skipped.push({
        path: '/executions/*/tasks',
        reason: 'wall-clock-budget',
        remaining,
      });
      wallClockEarlyExit = true;
      break;
    }
    const batch = sorted.slice(i, i + concurrency);
    traceFn(`fetch executions batch start [${batch.map((e) => e.id).join(',')}]`);
    const batchResults = await Promise.all(
      batch.map(async (ex) => {
        const tasksPromise = paginateFn(`/executions/${ex.id}/tasks`);
        const timeoutPromise = new Promise((resolve) => {
          setTimeout(() => resolve(EXEC_TIMEOUT_SENTINEL), execTimeoutMs);
        });
        const result = await Promise.race([tasksPromise, timeoutPromise]);
        return { id: ex.id, result };
      }),
    );
    for (const { id, result } of batchResults) {
      if (result === EXEC_TIMEOUT_SENTINEL) {
        skipped.push({
          path: '/executions/*/tasks',
          reason: 'exec-timeout',
          executions: [id],
        });
        continue;
      }
      rawTasks.push(...result);
    }
  }
  return { rawTasks, skipped, wallClockEarlyExit };
}

test('INVARIANT: slow exec only loses itself; 4 sibling tasks preserved', async () => {
  // Today's regression: pre-fix whole-batch race dropped all 5 exec tasks
  // when one (exec 2028) exceeded the deadline. Post-fix: only 2028 lost.
  const execList = [
    { id: 2028 }, // slow
    { id: 2127 },
    { id: 2121 },
    { id: 2102 },
    { id: 2085 },
  ];
  const paginateFn = async (apiPath) => {
    const m = apiPath.match(/\/executions\/(\d+)\/tasks$/);
    const execId = Number(m[1]);
    if (execId === 2028) {
      await new Promise((r) => setTimeout(r, 200));
      return [{ id: 'T_2028' }];
    }
    return [{ id: `T_${execId}` }];
  };
  const result = await phase2BatchFetch({
    allExecs: execList,
    paginateFn,
    concurrency: 3,
    execTimeoutMs: 80,
  });
  assert.equal(result.rawTasks.length, 4, '4 sibling exec tasks must survive');
  const ids = result.rawTasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ['T_2085', 'T_2102', 'T_2121', 'T_2127']);
  assert.deepEqual(result.skipped, [{
    path: '/executions/*/tasks',
    reason: 'exec-timeout',
    executions: [2028],
  }], 'only the slow exec should be recorded as skipped');
});

test('INVARIANT: multiple slow execs each tracked individually, not as a group', async () => {
  // Two slow execs in different batches; both should be skipped as separate
  // entries with their own ids, NOT lumped as a batch.
  const execList = [
    { id: 1 }, { id: 2 }, { id: 3 }, // batch 1 — exec 2 slow
    { id: 4 }, { id: 5 }, { id: 6 }, // batch 2 — exec 5 slow
  ];
  const paginateFn = async (apiPath) => {
    const m = apiPath.match(/\/executions\/(\d+)\/tasks$/);
    const execId = Number(m[1]);
    if (execId === 2 || execId === 5) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return [{ id: `T_${execId}` }];
  };
  const result = await phase2BatchFetch({
    allExecs: execList,
    paginateFn,
    concurrency: 3,
    execTimeoutMs: 80,
  });
  assert.equal(result.rawTasks.length, 4, '4 fast execs survive across both batches');
  assert.deepEqual(result.skipped.map((s) => s.executions), [[2], [5]],
    'skipped should record each slow exec separately');
});

test('VOC-first ordering: VOC-owned execs fetched before non-VOC', async () => {
  const execList = [
    { id: 100 }, // non-VOC
    { id: 200 }, // VOC
    { id: 300 }, // non-VOC
    { id: 400 }, // VOC
  ];
  const vocOwnedExecutionIds = new Set([200, 400]);
  const fetchOrder = [];
  const paginateFn = async (apiPath) => {
    const m = apiPath.match(/\/executions\/(\d+)\/tasks$/);
    const execId = Number(m[1]);
    fetchOrder.push(execId);
    return [{ id: `T_${execId}` }];
  };
  await phase2BatchFetch({
    allExecs: execList,
    paginateFn,
    vocOwnedExecutionIds,
    concurrency: 2,
  });
  assert.ok(vocOwnedExecutionIds.has(fetchOrder[0]), `expected first fetched in VOC set, got ${fetchOrder[0]}`);
  assert.ok(vocOwnedExecutionIds.has(fetchOrder[1]), `expected second fetched in VOC set, got ${fetchOrder[1]}`);
  assert.equal(vocOwnedExecutionIds.has(fetchOrder[2]), false, `expected third fetched outside VOC set, got ${fetchOrder[2]}`);
});

test('wall-clock budget exhaustion: stop enqueuing further batches', async () => {
  const execList = [
    { id: 1 }, { id: 2 }, { id: 3 },
    { id: 4 }, { id: 5 }, { id: 6 },
  ];
  const paginateFn = async (apiPath) => {
    const m = apiPath.match(/\/executions\/(\d+)\/tasks$/);
    return [{ id: `T_${m[1]}` }];
  };
  // Mock clock: first poll returns 0 (under budget), second returns past deadline.
  const clockValues = [0, 9_999_999];
  let callIdx = 0;
  const nowFn = () => clockValues[Math.min(callIdx++, clockValues.length - 1)];
  const result = await phase2BatchFetch({
    allExecs: execList,
    paginateFn,
    concurrency: 3,
    wallDeadlineMs: 1000,
    startTimeMs: 0,
    nowFn,
  });
  assert.equal(result.rawTasks.length, 3, 'first batch (3 execs) processed before budget exhausted');
  assert.equal(result.wallClockEarlyExit, true);
  assert.deepEqual(result.skipped, [{
    path: '/executions/*/tasks',
    reason: 'wall-clock-budget',
    remaining: 3,
  }]);
});

test('REGRESSION CANARY: if someone restores whole-batch race, this test should fail', async () => {
  // Synthesizes the pre-fix scenario and asserts the post-fix behavior:
  // before fix, a single slow exec poisoned the entire 5-exec batch and
  // rawTasks would be empty. After fix, only the slow exec is lost.
  const execList = [
    { id: 2028 }, // slow — VOC 班牛 sprint stand-in
    { id: 2127 }, { id: 2121 }, { id: 2102 }, { id: 2085 },
  ];
  const paginateFn = async (apiPath) => {
    const m = apiPath.match(/\/executions\/(\d+)\/tasks$/);
    const execId = Number(m[1]);
    if (execId === 2028) {
      await new Promise((r) => setTimeout(r, 200));
      return [{ id: 'T44013', storyID: 21311 }]; // active VOC task
    }
    return [{ id: `T_${execId}` }];
  };
  const result = await phase2BatchFetch({
    allExecs: execList,
    paginateFn,
    concurrency: 5, // whole-batch concurrency — matches the day-of incident batch size
    execTimeoutMs: 80,
  });
  // Pre-fix: result.rawTasks would be []. Post-fix: 4 sibling tasks survive.
  assert.notEqual(result.rawTasks.length, 0,
    'REGRESSION: rawTasks empty would mean whole-batch race regressed');
  assert.equal(result.rawTasks.length, 4,
    'exactly 4 siblings should survive (2028 lost, others kept)');
});
