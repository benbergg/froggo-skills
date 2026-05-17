'use strict';
// V4 contract tests: product-scoped collection (replaces V3 view.sprints scan).
//
// V4 pivots from "scan everything the user can see (2228 sprints × 121
// products)" to "scan only the products the user actually owns" — defaulting
// to product 95 (VOC) which empirically owns 100% of qingwa's task and bug
// history (verified across W18/W19/W20). Override via WEEKLY_PRODUCT_IDS env
// or --products CLI arg when temporarily borrowing into other products.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

beforeEach(() => {
  delete process.env.WEEKLY_PRODUCT_IDS;
  delete require.cache[require.resolve('../references/scripts/collect-weekly.js')];
});

test('default product list is [95] when no env / no CLI override', () => {
  const collect = require('../references/scripts/collect-weekly.js');
  assert.deepEqual(collect.resolveProductIds([]), [95],
    'default product scope must be [95] (VOC) so weekly-report works out of the box for qingwa without env');
});

test('WEEKLY_PRODUCT_IDS env overrides default', () => {
  process.env.WEEKLY_PRODUCT_IDS = '95,114';
  delete require.cache[require.resolve('../references/scripts/collect-weekly.js')];
  const collect = require('../references/scripts/collect-weekly.js');
  assert.deepEqual(collect.resolveProductIds([]), [95, 114]);
});

test('CLI --products takes precedence over env', () => {
  process.env.WEEKLY_PRODUCT_IDS = '95';
  delete require.cache[require.resolve('../references/scripts/collect-weekly.js')];
  const collect = require('../references/scripts/collect-weekly.js');
  assert.deepEqual(collect.resolveProductIds(['200']), [200],
    'CLI must win over env so operators can probe ad-hoc without unsetting env');
});

test('resolveProductIds trims whitespace and rejects non-numeric tokens', () => {
  const collect = require('../references/scripts/collect-weekly.js');
  assert.deepEqual(collect.resolveProductIds(['95, 114 , 121']), [95, 114, 121]);
  assert.throws(() => collect.resolveProductIds(['95,abc']),
    /WEEKLY_PRODUCT_IDS/,
    'non-numeric tokens must throw, not silently drop');
});

test('does NOT export any view.sprints-based helper — V3 silent-trim path is gone', () => {
  const collect = require('../references/scripts/collect-weekly.js');
  assert.equal(collect.fetchUserViews, undefined,
    'fetchUserViews must be removed — V4 does not consume user.profile.view.sprints/products');
  assert.equal(collect.gatherRecentActiveExecIds, undefined,
    'gatherRecentActiveExecIds must be removed — V4 walks product → projects → executions instead');
  assert.equal(collect.filterToDoingSprints, undefined,
    'no upstream sprint filters of any kind');
});

test('exports the surface the V4 main loop and tests depend on', () => {
  const collect = require('../references/scripts/collect-weekly.js');
  assert.equal(typeof collect.fetchExecutionTasksScoped, 'function');
  assert.equal(typeof collect.resolveProductIds, 'function');
});
