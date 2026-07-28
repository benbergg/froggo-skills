'use strict';
// Unit tests for token 刷新的**单飞**与**前置刷新**(2026-07-28)。
//
// 背景实证(tencent-vm,run 2026-07-28T053135,监控日志时间线):
//   seq1-seq8 中 6 条请求在同一毫秒发起(inflight 爬到 6),**全部 401**:
//     seq1 /users                          401  1.3s
//     seq2 /products/*                     401  2.5s
//     seq3 /products/*/bugs?status=unclosed 401  3.5s
//     seq4 /products/*/bugs?status=all      401  4.8s
//     seq6 /products/*/stories              401  5.9s
//     seq8 /products/*/stories?closedstory  401 10.0s
//   每条 401 各自走 refreshTokenViaBash() → 6 次 spawnSync 串行登录。
//   spawnSync 同步阻塞事件循环,期间所有 in-flight fetch 的响应无法被处理,
//   而服务端计时照走 —— 该轮 phase1 被拖到 31.6s(同日无 401 的轮次 ~10s),
//   且 seq13 单条 bugs?status=all 观测到 25.7s(串行对照实验同一查询 6.1s)。
//   最坏情况更糟:refreshTokenViaBash 内部自带 3 次重试(30s timeout + 5s
//   sleep),6 条并发全部走满就是 6×105s = 630s,直接吃穿 900s 硬预算。
//
// cron 每天只跑一次,两次运行间隔 24h 必然超过禅道 token 存活期,
// 所以**每次 cron 都以 401 风暴开场** —— 这不是偶发,是常态路径。
//
// 锁定两条不变式:
//   1. 单飞:一批并发请求同时 401,只允许发生一次真实刷新
//   2. 前置刷新:token 过旧时在 phase1 之前就换掉,让风暴根本不发生

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const {
  ztFetch, STATE, TOKEN, tokenNeedsProactiveRefresh, TOKEN_MAX_AGE_MIN,
} = require('../references/scripts/collect.js');

const realFetch = globalThis.fetch;
const realRefresh = TOKEN.refresh;
const realRead = TOKEN.read;

beforeEach(() => {
  STATE.baseUrl = 'http://test.invalid';
  STATE.token = 'old-token';
  STATE.apiCalls = 0;
  STATE.budget = 100;
  STATE.budgetExceeded = false;
  STATE.skipped = [];
  TOKEN.gen = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  TOKEN.refresh = realRefresh;
  TOKEN.read = realRead;
});

// ---- 单飞 ---------------------------------------------------------------

test('6 条并发请求同时 401,只发生 1 次真实刷新', async () => {
  let refreshCalls = 0;
  let handedOut = 0;
  TOKEN.refresh = () => { refreshCalls++; };
  TOKEN.read = () => `fresh-token-${++handedOut}`;

  // 所有请求都用旧 token 出发;只要 header 里还是旧 token 就返回 401。
  globalThis.fetch = async (url, opts) => {
    const t = opts.headers.Token;
    if (t === 'old-token') return { status: 401, ok: false, text: async () => '' };
    return { status: 200, ok: true, text: async () => JSON.stringify({ data: t }) };
  };

  const results = await Promise.all(
    ['/a', '/b', '/c', '/d', '/e', '/f'].map((p) => ztFetch(p))
  );

  assert.equal(refreshCalls, 1, `期望只刷新 1 次,实际 ${refreshCalls} 次 —— 单飞失效即回归 401 风暴`);
  assert.ok(results.every((r) => r.ok), '所有请求最终都应成功');
});

test('单飞后的其余请求必须用刷新出来的新 token 重试,不能用旧 token', async () => {
  TOKEN.refresh = () => {};
  TOKEN.read = () => 'fresh-token';
  const tokensSeen = [];

  globalThis.fetch = async (url, opts) => {
    tokensSeen.push(opts.headers.Token);
    if (opts.headers.Token === 'old-token') return { status: 401, ok: false, text: async () => '' };
    return { status: 200, ok: true, text: async () => '{}' };
  };

  await Promise.all(['/a', '/b', '/c'].map((p) => ztFetch(p)));

  const retried = tokensSeen.filter((t) => t === 'fresh-token');
  assert.equal(retried.length, 3, '3 条请求都应该用新 token 重试一次');
});

test('单条请求 401 仍然正常刷新(单飞不能把正常路径也压掉)', async () => {
  let refreshCalls = 0;
  TOKEN.refresh = () => { refreshCalls++; };
  TOKEN.read = () => 'fresh-token';

  globalThis.fetch = async (url, opts) =>
    (opts.headers.Token === 'old-token'
      ? { status: 401, ok: false, text: async () => '' }
      : { status: 200, ok: true, text: async () => '{}' });

  const r = await ztFetch('/solo');
  assert.equal(refreshCalls, 1);
  assert.equal(r.ok, true);
});

test('两轮独立的 401(token 二次失效)应各刷新一次,而不是永远只刷一次', async () => {
  let refreshCalls = 0;
  const chain = ['gen1-token', 'gen2-token'];
  TOKEN.refresh = () => { refreshCalls++; };
  TOKEN.read = () => chain[refreshCalls - 1];

  let phase = 1;
  globalThis.fetch = async (url, opts) => {
    const t = opts.headers.Token;
    if (phase === 1 && t === 'old-token') return { status: 401, ok: false, text: async () => '' };
    if (phase === 2 && t === 'gen1-token') return { status: 401, ok: false, text: async () => '' };
    return { status: 200, ok: true, text: async () => '{}' };
  };

  await ztFetch('/first');
  assert.equal(refreshCalls, 1);

  phase = 2;
  await ztFetch('/second');
  assert.equal(refreshCalls, 2, '新一代 token 再失效时必须能再刷一次');
});

test('刷新抛错时错误必须向上传播,不能被单飞吞掉', async () => {
  TOKEN.refresh = () => { throw new Error('zt_acquire_token failed'); };
  globalThis.fetch = async () => ({ status: 401, ok: false, text: async () => '' });

  const r = await ztFetch('/x');
  assert.equal(r.ok, false, '刷新失败的请求必须失败,不能静默返回空数据');
});

test('刷新后 token 文件为空时不得把空 token 写进 STATE', async () => {
  TOKEN.refresh = () => {};
  TOKEN.read = () => null;
  globalThis.fetch = async () => ({ status: 401, ok: false, text: async () => '' });

  await ztFetch('/x');
  assert.equal(STATE.token, 'old-token', 'STATE.token 不能被 null 覆盖');
});

// ---- 401 必须可见 -------------------------------------------------------
//
// 禅道对失效 token 明确回 401 + {"error":"Unauthorized"} —— 信息一直都在,
// 是 ztFetch 从不往外说。2026-07-28 之前 401 全程零痕迹:stdout 没有、
// trace 没有、exit code 正常、api_calls 只是多了 6(那数字本来就天天浮动)。
// token 风暴因此躲过了好几轮排查。「能自愈」不等于「没成本」。

test('401 必须打到 stderr,不能静默自愈', async () => {
  TOKEN.refresh = () => {};
  TOKEN.read = () => 'fresh-token';
  globalThis.fetch = async (url, opts) =>
    (opts.headers.Token === 'old-token'
      ? { status: 401, ok: false, text: async () => '{"error":"Unauthorized"}' }
      : { status: 200, ok: true, text: async () => '{}' });

  const lines = [];
  const realErr = console.error;
  console.error = (m) => lines.push(String(m));
  try {
    await ztFetch('/products/95/bugs?status=all&order=closedDate_desc');
  } finally {
    console.error = realErr;
  }

  assert.equal(lines.length, 1, '401 必须恰好产生一行提示');
  assert.match(lines[0], /401/, '提示必须点明是 401');
  assert.match(lines[0], /\/products\/95\/bugs/, '提示必须带上是哪个请求撞的');
  assert.ok(!lines[0].includes('status=all'), 'query string 不入日志,避免泄漏参数');
});

test('复用他人刷新结果的那些 401 也要各自可见(否则单飞回归时看不出次数变化)', async () => {
  TOKEN.refresh = () => {};
  TOKEN.read = () => 'fresh-token';
  globalThis.fetch = async (url, opts) =>
    (opts.headers.Token === 'old-token'
      ? { status: 401, ok: false, text: async () => '' }
      : { status: 200, ok: true, text: async () => '{}' });

  const lines = [];
  const realErr = console.error;
  console.error = (m) => lines.push(String(m));
  try {
    await Promise.all(['/a', '/b', '/c'].map((p) => ztFetch(p)));
  } finally {
    console.error = realErr;
  }

  assert.equal(lines.length, 3, '3 条 401 应各打一行');
  assert.equal(lines.filter((l) => l.includes('本条负责重新登录')).length, 1,
    '只有 1 条承担真实登录 —— 这行数字就是单飞是否还活着的直接读数');
  assert.equal(lines.filter((l) => l.includes('复用本批已刷新的 token')).length, 2);
});

// ---- 前置刷新 -----------------------------------------------------------

const NOW = Date.parse('2026-07-28T12:00:00Z');

test('token 年龄超过阈值 → 需要前置刷新', () => {
  const meta = { token: 'x', acquired_at: '2026-07-27T20:00:00Z' }; // 16h 前
  assert.equal(tokenNeedsProactiveRefresh(meta, NOW, 120), true);
});

test('token 刚取不久 → 不需要前置刷新(避免每次跑都白烧一次登录)', () => {
  const meta = { token: 'x', acquired_at: '2026-07-28T11:30:00Z' }; // 30min 前
  assert.equal(tokenNeedsProactiveRefresh(meta, NOW, 120), false);
});

test('缺 acquired_at 字段 → 保守判定为需要刷新', () => {
  assert.equal(tokenNeedsProactiveRefresh({ token: 'x' }, NOW, 120), true);
});

test('acquired_at 不可解析 → 保守判定为需要刷新', () => {
  assert.equal(tokenNeedsProactiveRefresh({ token: 'x', acquired_at: 'garbage' }, NOW, 120), true);
});

test('无 token 缓存 → 需要刷新', () => {
  assert.equal(tokenNeedsProactiveRefresh(null, NOW, 120), true);
});

test('acquired_at 在未来(时钟漂移) → 不当成过期,也不能算出负年龄', () => {
  const meta = { token: 'x', acquired_at: '2026-07-28T13:00:00Z' };
  assert.equal(tokenNeedsProactiveRefresh(meta, NOW, 120), false);
});

test('默认阈值必须显著短于 cron 间隔(24h),否则前置刷新永远不触发', () => {
  assert.ok(TOKEN_MAX_AGE_MIN > 0, '阈值必须为正');
  assert.ok(
    TOKEN_MAX_AGE_MIN <= 12 * 60,
    `默认阈值 ${TOKEN_MAX_AGE_MIN} 分钟过长:cron 每 24h 跑一次,` +
    '阈值必须远小于该间隔才能在 phase1 之前把旧 token 换掉'
  );
});

test('阈值恰好等于年龄时判定为需要刷新(边界取闭区间,宁可多刷一次)', () => {
  const meta = { token: 'x', acquired_at: '2026-07-28T10:00:00Z' }; // 正好 120min
  assert.equal(tokenNeedsProactiveRefresh(meta, NOW, 120), true);
});
