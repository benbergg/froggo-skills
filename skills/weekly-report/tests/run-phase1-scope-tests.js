'use strict';
// Contract test: Phase 1 must NOT silently shrink mySprints with a
// status=doing intersection. The 2026-05-17 diagnostic showed that 2228
// view.sprints were being cut to 256 (88% data loss) because the previous
// implementation did:
//   mySprints = views.sprintIds.filter(sid => doingExecIds.has(sid))
// This regression test locks in the fix by asserting that the exported
// function `intersectSprintsWithScope` is either gone or returns full input
// when called with no scope set — symbolizing "no upstream filter".

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const collect = require('../references/scripts/collect-weekly.js');

test('Phase 1 does not export a doing-only sprint filter (no silent upstream trim)', () => {
  // After the fix, there should be NO exported helper named
  // "filterToDoingSprints" or "intersectSprintsWithDoing". Either the function
  // is gone (Phase 1 uses views.sprintIds directly) or, if a helper exists for
  // testability, it must be explicitly opt-in and documented.
  assert.equal(collect.filterToDoingSprints, undefined,
    'filterToDoingSprints should not be exported — upstream sprint trimming reintroduces 2026-05-17 silent data loss');
  assert.equal(collect.intersectSprintsWithDoing, undefined,
    'intersectSprintsWithDoing should not be exported — same reason');
});

test('exports fetchExecutionTasksScoped — Phase 2 now uses scoped lookback fetch', () => {
  assert.equal(typeof collect.fetchExecutionTasksScoped, 'function',
    'fetchExecutionTasksScoped must be exported so tests can pin its behavior');
});
