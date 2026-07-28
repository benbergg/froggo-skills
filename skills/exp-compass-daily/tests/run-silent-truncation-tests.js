'use strict';
// Unit tests for **静默截断**类缺陷(2026-07-28 白盒审计)。
//
// 共同病灶与 401 静默自愈同构:代码遇到"能降级的情况"就默默降级,
// 不写 STATE.skipped、不打 WARN、exit 0 —— 于是数据缺失时所有信号都正常。
// 401 那次教训是"能自愈不等于没成本";这里是"能降级不等于可以不说"。
//
// 三处:
//   1. fetchTodayClosedBugs / fetchClosedTodayStories 单页扫 100 条,靠
//      `day < date` 判定扫到头。100 条全落在目标日或之后时循环自然走完,
//      第 101 条起的今日数据静默丢失。
//      实测余量(2026-07-28,product 95):
//        bugs?status=all       total=1381,第 100 条 closedDate=2026-06-30(28 天)
//        stories?closedstory   total=572, 第 100 条 closedDate=2026-04-15(104 天)
//      当前安全,但判据是零成本的:循环是"因 break 退出"还是"自然走完"。
//   2. ztPaginate 的 MAX_PAGES=20 安全阀撞上时直接 return,不留痕迹。
//      当前调用点 total 均为个位到百位数(unclosed bugs 6 / stories 96 /
//      executions 91),离 2000 极远,但安全阀本就是给"没预料到的增长"准备的,
//      而它撞上时恰恰最需要出声。
//   3. fetchAllExecutionTasks 首轮成功时不清 exec 的 skipped,重试轮成功时清。
//      三腿里一条失败但另两条覆盖了数据时,整体 ok:true 而 skipped 非空,
//      于是首轮遇到 → 走 .partial → 日报不发;重试轮遇到 → 正常发。
//      同样的数据完整度,两条路径结论相反。

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const {
  ztPaginate, STATE, fetchClosedTodayStories, fetchTodayClosedBugs,
  fetchAllExecutionTasks,
} = require('../references/scripts/collect.js');

const realFetch = globalThis.fetch;

beforeEach(() => {
  STATE.baseUrl = 'http://test.invalid';
  STATE.token = 'x';
  STATE.apiCalls = 0;
  STATE.budget = 10000;
  STATE.budgetExceeded = false;
  STATE.skipped = [];
});

afterEach(() => { globalThis.fetch = realFetch; });

// 造 n 条 closedDate 全为 day 的记录
const rows = (n, day, key = 'closedDate') =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, [key]: `${day} 10:00:00` }));

// ---- 1. 单页扫描窗口耗尽 -------------------------------------------------

test('今日关闭 story:100 条全是当天 → 窗口耗尽,必须记 skipped', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, body: { stories: rows(100, '2026-07-28') } });
  const state = { skipped: [] };
  const out = await fetchClosedTodayStories(95, '2026-07-28', { fetchFn, state });

  assert.equal(out.length, 100, '取到的 100 条仍应返回');
  assert.equal(state.skipped.length, 1, '窗口耗尽必须留痕,否则第 101 条起静默丢失');
  assert.match(state.skipped[0].reason, /window/, `reason 应点明是窗口问题,实际 ${state.skipped[0].reason}`);
});

test('今日关闭 story:扫到更早日期就 break → 窗口够,不得误报', async () => {
  const body = { stories: [...rows(3, '2026-07-28'), ...rows(97, '2026-06-01')] };
  const fetchFn = async () => ({ ok: true, status: 200, body });
  const state = { skipped: [] };
  const out = await fetchClosedTodayStories(95, '2026-07-28', { fetchFn, state });

  assert.equal(out.length, 3);
  assert.equal(state.skipped.length, 0, '正常早退不能报窗口耗尽 —— 误报会让日报天天不发');
});

test('今日关闭 story:服务端返回不足 100 条 → 已给全,不算窗口耗尽', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, body: { stories: rows(12, '2026-07-28') } });
  const state = { skipped: [] };
  await fetchClosedTodayStories(95, '2026-07-28', { fetchFn, state });

  assert.equal(state.skipped.length, 0,
    'rows < limit 说明服务端把符合条件的全给了,没有被截断');
});

test('今日关闭 bug:100 条全是当天 → 窗口耗尽,必须记 skipped', async () => {
  const fetchFn = async () => ({ ok: true, status: 200, body: { bugs: rows(100, '2026-07-28') } });
  const state = { skipped: [] };
  const out = await fetchTodayClosedBugs(95, '2026-07-28', { fetchFn, state });

  assert.equal(out.length, 100);
  assert.equal(state.skipped.length, 1, 'bug 侧同样要留痕');
  assert.match(state.skipped[0].reason, /window/);
});

test('今日关闭 bug:遇到 closedDate=null(未关闭 bug 排在尾部)→ 扫到头,不算耗尽', async () => {
  const body = { bugs: [...rows(2, '2026-07-28'), ...Array.from({ length: 98 }, (_, i) => ({ id: 900 + i, closedDate: null }))] };
  const fetchFn = async () => ({ ok: true, status: 200, body });
  const state = { skipped: [] };
  const out = await fetchTodayClosedBugs(95, '2026-07-28', { fetchFn, state });

  assert.equal(out.length, 2);
  assert.equal(state.skipped.length, 0, 'null 聚在尾部是正常的扫到头信号');
});

// ---- 2. ztPaginate 撞页数上限 -------------------------------------------

test('ztPaginate:total 超过 20 页能承载的量 → 截断必须记 skipped', async () => {
  // total=2500 需要 25 页,MAX_PAGES=20 只能取 2000
  globalThis.fetch = async () => ({
    status: 200, ok: true,
    text: async () => JSON.stringify({ total: 2500, bugs: rows(100, '2026-07-28') }),
  });

  const out = await ztPaginate('/products/95/bugs?status=all', 'bugs');

  assert.equal(out.length, 2000, '仍应返回能取到的 2000 条');
  const trunc = STATE.skipped.filter((s) => /truncat/.test(String(s.reason)));
  assert.equal(trunc.length, 1, '撞上安全阀必须留痕 —— 它正是为"没预料到的增长"准备的');
  assert.equal(trunc[0].total, 2500, 'skipped 里要带上真实 total,否则没法判断差多少');
});

test('ztPaginate:total 在 20 页以内 → 正常取齐,不得误报截断', async () => {
  // 页码必须从 URL 解析:第 2 页起是并发取的,按调用次序猜页码会错位。
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return {
      status: 200, ok: true,
      text: async () => JSON.stringify({ total: 250, bugs: rows(page <= 2 ? 100 : 50, '2026-07-28') }),
    };
  };

  const out = await ztPaginate('/products/95/bugs?status=all', 'bugs');
  assert.equal(out.length, 250);
  assert.equal(STATE.skipped.filter((s) => /truncat/.test(String(s.reason))).length, 0);
});

// ---- 3. 首轮 / 重试轮 skipped 处理一致性 ---------------------------------

test('首轮 exec 整体成功时,必须清掉部分腿失败留下的 skipped(与重试轮一致)', async () => {
  const state = { skipped: [] };
  // 模拟 fetchExecutionTasksScoped:内部一条腿失败留了记录,但整体 ok
  const fetchExecFn = async (execId) => {
    state.skipped.push({ path: '/executions/*/tasks', page: 2, execId, reason: 'leg-failed' });
    return { ok: true, items: [{ id: 1 }, { id: 2 }] };
  };

  const r = await fetchAllExecutionTasks([{ id: 2028 }], '2026-07-28', {
    fetchExecFn, state, traceFn: () => {}, wallDeadlineMs: 600_000, nowFn: () => 0, startMs: 0,
  });

  assert.equal(r.rawTasks.length, 2, '数据本身是完整的');
  assert.equal(state.skipped.length, 0,
    '整体 ok 时残留的腿级记录会把日报打进 .partial —— 而重试轮遇到同样情况会清掉,' +
    '两条路径必须给出一致结论');
});

test('首轮 exec 整体失败时,skipped 必须保留(清理不能过头)', async () => {
  const state = { skipped: [] };
  const fetchExecFn = async () => ({ ok: false, items: [] });

  await fetchAllExecutionTasks([{ id: 2028 }], '2026-07-28', {
    fetchExecFn, state, traceFn: () => {}, retryFailed: false,
    wallDeadlineMs: 600_000, nowFn: () => 0, startMs: 0,
  });

  assert.equal(state.skipped.length, 1, '真失败必须留痕');
  assert.match(String(state.skipped[0].reason), /scoped-fetch-failed/);
});
