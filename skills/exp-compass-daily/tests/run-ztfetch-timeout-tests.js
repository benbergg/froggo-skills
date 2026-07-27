'use strict';
// Unit tests for ztFetch 的超时语义(2026-07-27 修复)。
//
// 背景实证(tencent-vm → chandao 生产实例,2026-07-27 21:00):
//   /executions/2028/tasks?order=lastEditedDate_desc  串行 14.6s
//   /executions/3247/tasks?...                        串行 13.7s
//   /executions/3436/tasks?...                        串行 59.3s(total 仅 73 条)
// 旧的 15s 固定超时低于该端点常态耗时,且 AbortError 在重试白名单里,于是
// 一次慢响应被放大成 3×(15s + backoff) ≈ 48s 的纯等待且拿不到数据 —— 20:20
// 那轮 3 个 execution 就是这样一起撞穿 120s 上限,rawTasks=0 → exit 2 → 日报未发。
//
// 锁定两条不变式:
//   1. 超时值可按调用点覆盖(慢端点用 SLOW_REQ_TIMEOUT_MS)
//   2. 本地超时(AbortError)不重试;真网络错误仍重试

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const { ztFetch, STATE, REQ_TIMEOUT_MS, SLOW_REQ_TIMEOUT_MS } = require('../references/scripts/collect.js');

const realFetch = globalThis.fetch;

beforeEach(() => {
  STATE.baseUrl = 'http://test.invalid';
  STATE.token = 'x';
  STATE.apiCalls = 0;
  STATE.budget = 100;
  STATE.budgetExceeded = false;
  STATE.skipped = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('慢端点超时默认值必须高于该端点实测耗时(11.5-59.3s)', () => {
  assert.ok(SLOW_REQ_TIMEOUT_MS >= 90_000,
    `SLOW_REQ_TIMEOUT_MS=${SLOW_REQ_TIMEOUT_MS} 太小:/executions/*/tasks 实测尾部 59.3s,需留 1.5x 余量`);
  assert.ok(REQ_TIMEOUT_MS >= 20_000,
    `REQ_TIMEOUT_MS=${REQ_TIMEOUT_MS} 太小:普通端点也观测到 14s+`);
});

test('AbortError(本地超时)不重试——只发一次请求', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    throw e;
  };
  const r = await ztFetch('/executions/2028/tasks?page=1');
  assert.equal(r.ok, false);
  assert.equal(calls, 1, '超时重试只会把一次慢响应放大成 N 倍等待,不能重试');
});

test('AbortError 被 undici 包进 cause 时同样不重试', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    // 某些 node/undici 版本把 abort 包成 TypeError: fetch failed,真实原因在 cause
    const inner = new Error('This operation was aborted');
    inner.name = 'AbortError';
    const e = new TypeError('fetch failed');
    e.cause = inner;
    throw e;
  };
  const r = await ztFetch('/executions/2028/tasks?page=1');
  assert.equal(r.ok, false);
  assert.equal(calls, 1, 'cause 里的 AbortError 也必须识别为超时,不能走 fetch failed 的重试分支');
});

test('真网络错误仍重试(共 3 次尝试)', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const e = new TypeError('fetch failed');
    e.cause = { code: 'ECONNRESET' };
    throw e;
  };
  const r = await ztFetch('/products/95/bugs?page=1');
  assert.equal(r.ok, false);
  assert.equal(calls, 3, 'ECONNRESET 等瞬时网络抖动仍应重试 2 次');
});

test('timeoutMs 可按调用点覆盖', async () => {
  let seenSignal = null;
  globalThis.fetch = async (_url, opts) => {
    seenSignal = opts.signal;
    // 立即返回,不触发 abort
    return { status: 200, ok: true, text: async () => '{"tasks":[]}' };
  };
  const r = await ztFetch('/executions/2028/tasks?page=1', { timeoutMs: SLOW_REQ_TIMEOUT_MS });
  assert.equal(r.ok, true);
  assert.ok(seenSignal, '必须传 AbortSignal');
});

test('超时确实按传入的 timeoutMs 触发(短超时 + 慢响应)', async () => {
  globalThis.fetch = async (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const t0 = Date.now();
  const r = await ztFetch('/executions/2028/tasks?page=1', { timeoutMs: 120 });
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.ok(elapsed < 1000, `应在 ~120ms 内放弃,实际 ${elapsed}ms(说明发生了不该有的重试)`);
});
