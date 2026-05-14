'use strict';
// Unit tests for isLongClosed filter in collect.js (O1, 2026-05-14).
//
// "Long closed" means an execution whose status is closed/suspended AND
// whose lastEditedDate is strictly older than (today - lookbackDays).
//
// Why this filter:
//   ~80 of ~120 VOC-owned executions are historical sprints already closed.
//   Phase2 re-pulls every one daily, eating 5-6 min of wall-clock for ~0
//   new tasks. O1 drops them before fetch.
//
// Edge cases this protects:
//   - sprint closed TODAY with tasks finished today → KEEP (lastEditedDate
//     still within window).
//   - missing lastEditedDate from a buggy Zentao response → KEEP (err on
//     the side of fetching rather than silently dropping data).
//   - unknown status string from API drift → KEEP (same reason).

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const { isLongClosed } = require('../references/scripts/collect.js');

const TODAY = '2026-05-14';
// 30-day cutoff from 2026-05-14 = 2026-04-14. Strictly-before is stale.

test('SKIP: closed exec last edited 31 days ago', () => {
  const ex = { id: 1, status: 'closed', lastEditedDate: '2026-04-13' };
  assert.equal(isLongClosed(ex, TODAY), true);
});

test('KEEP: closed exec last edited today (just-closed sprint)', () => {
  const ex = { id: 2, status: 'closed', lastEditedDate: '2026-05-14' };
  assert.equal(isLongClosed(ex, TODAY), false);
});

test('KEEP: closed exec last edited 29 days ago (still in window)', () => {
  const ex = { id: 3, status: 'closed', lastEditedDate: '2026-04-15' };
  assert.equal(isLongClosed(ex, TODAY), false);
});

test('KEEP: closed exec edited exactly at cutoff (boundary inclusive)', () => {
  const ex = { id: 4, status: 'closed', lastEditedDate: '2026-04-14' };
  assert.equal(isLongClosed(ex, TODAY), false);
});

test('KEEP: doing exec ignored regardless of lastEditedDate', () => {
  const ex = { id: 5, status: 'doing', lastEditedDate: '2025-01-01' };
  assert.equal(isLongClosed(ex, TODAY), false);
});

test('KEEP: wait exec ignored regardless of lastEditedDate', () => {
  const ex = { id: 6, status: 'wait', lastEditedDate: '2025-01-01' };
  assert.equal(isLongClosed(ex, TODAY), false);
});

test('SKIP: suspended exec last edited 60 days ago', () => {
  const ex = { id: 7, status: 'suspended', lastEditedDate: '2026-03-15' };
  assert.equal(isLongClosed(ex, TODAY), true);
});

test('KEEP: suspended exec last edited today (just suspended)', () => {
  const ex = { id: 8, status: 'suspended', lastEditedDate: '2026-05-14' };
  assert.equal(isLongClosed(ex, TODAY), false);
});

test('CONSERVATIVE: null lastEditedDate keeps the exec', () => {
  const ex = { id: 9, status: 'closed', lastEditedDate: null };
  assert.equal(isLongClosed(ex, TODAY), false);
});

test('CONSERVATIVE: missing lastEditedDate field keeps the exec', () => {
  const ex = { id: 10, status: 'closed' };
  assert.equal(isLongClosed(ex, TODAY), false);
});

test('CONSERVATIVE: empty-string lastEditedDate keeps the exec', () => {
  const ex = { id: 11, status: 'closed', lastEditedDate: '' };
  assert.equal(isLongClosed(ex, TODAY), false);
});

test('UNKNOWN STATUS: arbitrary status string keeps the exec', () => {
  const ex = { id: 12, status: 'mysterious', lastEditedDate: '2025-01-01' };
  assert.equal(isLongClosed(ex, TODAY), false);
});

test('CUSTOM LOOKBACK: 7-day window flags a 10-day-stale closed exec', () => {
  const ex = { id: 13, status: 'closed', lastEditedDate: '2026-05-04' };
  assert.equal(isLongClosed(ex, TODAY, 7), true);
});

test('REGRESSION CANARY: VOC exec 2028 (closed Feb, long-stale) is skipped', () => {
  // 2026-05-13 incident: VOC sprint 2028 carried 1576 cumulative tasks and
  // killed phase2. Once closed, O1 prevents re-pulling its history daily.
  const ex = { id: 2028, status: 'closed', lastEditedDate: '2026-02-01' };
  assert.equal(isLongClosed(ex, TODAY), true);
});
