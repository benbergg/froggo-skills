'use strict';
// 2026-07-27 分页完整性契约测试。
//
// 起因:7-26 cron run seq 29 实证 —— `/products/95/bugs?status=all` total=1377,
// ztPaginate 用 limit=500 分 3 页,第 3 页 15s AbortController 超时被记为
// `{page:3, reason:'terminated'}` 后**静默跳过**,脚本照常 exit 0 + 输出 "OK",
// 周报因此丢了 377 条 bug 而没有任何告警。
//
// 本文件锁定两条契约:
//   1. limit=100(记忆 [[project-zentao-pagination-pitfalls]]:limit=500 尾延迟
//      抖动 4-24s+,limit=100 稳定 2-3s)。原 limit=500 的注释理由
//      ("weekly fans out across 121 products")在 V4 product-scoped 之后已失效
//      —— 实际只扫 [95] 一个 product。
//   2. 任何丢页都必须物理断路(非零 exit),而不是 exit 0 输出残缺 JSON。
//      参照同文件 budget_exceeded 已有的断路模式,复用 --allow-partial 逃生口。

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const MODULE_PATH = '../references/scripts/collect-weekly.js';

function freshModule() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

let collect;
beforeEach(() => {
  collect = freshModule();
  collect.STATE.skipped.length = 0;
});

// 造一个返回 `total` 条记录的假端点,按 limit/page 切片。
function makeFakeApi(total, listKey, { failPages = [] } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const limit = Number(/limit=(\d+)/.exec(url)[1]);
    const page = Number(/page=(\d+)/.exec(url)[1]);
    if (failPages.includes(page)) {
      return { ok: false, status: 0, body: null, reason: 'terminated' };
    }
    const start = (page - 1) * limit;
    const rows = [];
    for (let i = start; i < Math.min(start + limit, total); i++) rows.push({ id: i + 1 });
    return { ok: true, status: 200, body: { [listKey]: rows, total } };
  };
  return { fetchFn, calls };
}

test('ztPaginate 用 limit=100 分页,不再用尾延迟不稳的 limit=500', async () => {
  const { fetchFn, calls } = makeFakeApi(250, 'bugs');
  await collect.ztPaginate('/products/95/bugs?status=all', 'bugs', { fetchFn });

  assert.ok(calls.length > 0, 'ztPaginate 必须发出请求');
  for (const url of calls) {
    assert.match(url, /limit=100(&|$)/,
      `每页都必须用 limit=100,实际请求: ${url}`);
  }
});

test('ztPaginate 取回 total 声明的全部记录', async () => {
  const { fetchFn } = makeFakeApi(1377, 'bugs');
  const out = await collect.ztPaginate('/products/95/bugs?status=all', 'bugs', { fetchFn });

  assert.equal(out.length, 1377,
    'total=1377 时必须取满 1377 条 —— 这正是 7-26 只拿到 1000 条的回归场景');
  assert.deepEqual(collect.STATE.skipped, [], '全部成功时不应有 skipped');
});

test('单页失败时记录页号与原因到 STATE.skipped', async () => {
  const { fetchFn } = makeFakeApi(1377, 'bugs', { failPages: [3] });
  await collect.ztPaginate('/products/95/bugs?status=all', 'bugs', { fetchFn });

  assert.equal(collect.STATE.skipped.length, 1);
  assert.deepEqual(collect.STATE.skipped[0], {
    path: '/products/*/bugs?status=all',
    page: 3,
    reason: 'terminated',
  }, '丢页必须留痕,product id 需脱敏为 *');
});

test('total 超过 MAX_PAGES 覆盖范围时记 max-pages,不静默截断', async () => {
  // limit=100 × MAX_PAGES=40 → 4000 条上限。5000 条必须留痕。
  const { fetchFn } = makeFakeApi(5000, 'bugs');
  const out = await collect.ztPaginate('/products/95/bugs?status=all', 'bugs', { fetchFn });

  assert.ok(out.length < 5000, '超出上限时确实取不全');
  const maxPagesEntry = collect.STATE.skipped.find((s) => s.reason === 'max-pages');
  assert.ok(maxPagesEntry,
    'MAX_PAGES 截断必须记 skipped —— 否则又是一处 exit 0 的静默丢数据');
  assert.equal(maxPagesEntry.path, '/products/*/bugs?status=all');
});

test('assertDataComplete 在存在非 budget 丢页时判定为致命', () => {
  const skipped = [{ path: '/products/*/bugs?status=all', page: 3, reason: 'terminated' }];
  const r = collect.assertDataComplete(skipped, { allowPartial: false });

  assert.equal(r.fatal, true, '丢页必须物理断路,不能 exit 0 输出残缺周报');
  assert.match(r.message, /terminated/, '错误信息必须带上原因,便于判断是否重跑');
  assert.match(r.message, /allow-partial/, '错误信息必须给出逃生口');
});

test('assertDataComplete 在 --allow-partial 下放行', () => {
  const skipped = [{ path: '/products/*/bugs?status=all', page: 3, reason: 'terminated' }];
  const r = collect.assertDataComplete(skipped, { allowPartial: true });

  assert.equal(r.fatal, false, '显式 --allow-partial 时由操作者承担残缺风险');
});

test('assertDataComplete 忽略 budget 项,避免与 budget_exceeded 分支重复报错', () => {
  const skipped = [{ path: '/products/*/bugs?status=all', page: 3, reason: 'budget' }];
  const r = collect.assertDataComplete(skipped, { allowPartial: false });

  assert.equal(r.fatal, false,
    'budget 耗尽已有专属 exit 5 分支与专属提示,这里不重复拦截');
});

test('assertDataComplete 在无丢页时放行', () => {
  const r = collect.assertDataComplete([], { allowPartial: false });
  assert.equal(r.fatal, false);
});
