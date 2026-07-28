'use strict';
// Unit tests for lib/obs.js —— 采集可观测性。
//
// 锁定的不变式:
//   1. path 模式化(高基数 id 归一),否则聚合失效
//   2. source 区分 exec-tasks 三条腿,否则"哪条腿浪费"永远答不了
//   3. unique_contributed = 砍掉该 source 会丢的条数(核心指标)
//   4. 失败归因分类正确(timeout / network / budget / auth / 5xx ...)
//   5. **监控绝不能拖累采集**:任何异常都吞掉,主流程不受影响
//   6. 实时落盘:每条请求立刻可见,不等 finishRun

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-obs-'));
  process.env.EXP_COMPASS_LOG_DIR = tmpDir;
  delete require.cache[require.resolve('../references/scripts/lib/obs.js')];
});
afterEach(() => {
  delete process.env.EXP_COMPASS_LOG_DIR;
});

const load = () => require('../references/scripts/lib/obs.js');

// ---- path / source ------------------------------------------------------

test('path 模式化: 高基数 id 归一,避免聚合被打散', () => {
  const { normalizePath } = load()._internal;
  assert.equal(normalizePath('/executions/2028/tasks?order=x'), '/executions/*/tasks');
  assert.equal(normalizePath('/stories/22494'), '/stories/*');
  assert.equal(normalizePath('/products/95/bugs?status=unclosed'), '/products/*/bugs');
  assert.equal(normalizePath('/tasks/45878'), '/tasks/*');
  assert.equal(normalizePath('/users'), '/users');
});

test('source 必须区分 exec-tasks 的三条腿', () => {
  const { deriveSource } = load()._internal;
  const a = deriveSource('/executions/2028/tasks?order=lastEditedDate_desc&limit=100&page=1');
  const b = deriveSource('/executions/2028/tasks?order=openedDate_desc&limit=100&page=1');
  const c = deriveSource('/executions/3247/tasks?order=lastEditedDate_desc&limit=100&page=1');
  assert.notEqual(a, b, '不同腿必须是不同 source,否则无法判断哪条腿是浪费的');
  assert.equal(a, c, '同一条腿跨 execution 必须聚到一起');
  assert.match(a, /lastEditedDate_desc/);
});

test('source 保留 status 语义(unclosed vs all 是两种取法)', () => {
  const { deriveSource } = load()._internal;
  const u = deriveSource('/products/95/bugs?status=unclosed&limit=100&page=1');
  const all = deriveSource('/products/95/bugs?status=all&order=closedDate_desc&limit=100&page=1');
  assert.notEqual(u, all);
});

test('显式 source 覆盖自动推断(probe 与常规腿要分开)', () => {
  const { deriveSource } = load()._internal;
  assert.equal(deriveSource('/executions/2028/tasks?order=lastEditedDate_desc', 'exec-tasks:probe'), 'exec-tasks:probe');
});

// ---- id 抽取 ------------------------------------------------------------

test('extractIds: 列表 + 子任务都算这次调用的产出', () => {
  const { extractIds } = load()._internal;
  const ids = extractIds({ tasks: [{ id: 1, children: [{ id: 11 }, { id: 12 }] }, { id: 2 }] });
  assert.deepEqual(ids.sort((a, b) => a - b), [1, 2, 11, 12]);
});

test('extractIds: 详情响应本身算一个实体', () => {
  const { extractIds } = load()._internal;
  assert.deepEqual(extractIds({ id: 22494, title: 'x' }), [22494]);
});

test('extractIds: 认不出的结构返回空,不抛异常', () => {
  const { extractIds } = load()._internal;
  assert.deepEqual(extractIds(null), []);
  assert.deepEqual(extractIds('not json'), []);
  assert.deepEqual(extractIds({ weird: [1, 2] }), []);
});

// ---- 失败归因 -----------------------------------------------------------

test('失败归因分类', () => {
  const { classifyFailure } = load()._internal;
  assert.equal(classifyFailure({ ok: true }), null);
  assert.equal(classifyFailure({ ok: false, timedOut: true }), 'timeout');
  assert.equal(classifyFailure({ ok: false, reason: 'This operation was aborted' }), 'timeout');
  assert.equal(classifyFailure({ ok: false, reason: 'budget' }), 'budget');
  assert.equal(classifyFailure({ ok: false, status: 401 }), 'auth');
  assert.equal(classifyFailure({ ok: false, status: 503 }), 'server_5xx');
  assert.equal(classifyFailure({ ok: false, status: 429 }), 'rate_limit');
  assert.equal(classifyFailure({ ok: false, reason: 'fetch failed (ECONNRESET)' }), 'network');
});

// ---- 贡献度(核心) -------------------------------------------------------

test('CORE: unique_contributed = 砍掉该 source 会丢的条数', () => {
  const obs = load();
  obs.startRun({ date: '2026-07-28', product: 95 });

  // legA 拿到 1,2,3;legB 拿到 3,4(3 重复);legC 拿到 5 但 5 没进最终 payload
  const rec = (source, ids) => {
    const tk = obs.requestStart();
    obs.requestEnd(tk, { path: '/executions/2028/tasks', source, ok: true, status: 200, body: { tasks: ids.map((id) => ({ id })) } });
  };
  rec('legA', [1, 2, 3]);
  rec('legB', [3, 4]);
  rec('legC', [5]);

  const c = obs.computeContribution([1, 2, 3, 4]); // 5 未进 payload
  assert.deepEqual(c.legA, { contributed: 3, unique_contributed: 2 }, 'legA 独有 1,2(3 与 legB 重叠)');
  assert.deepEqual(c.legB, { contributed: 2, unique_contributed: 1 }, 'legB 独有 4');
  assert.deepEqual(c.legC, { contributed: 0, unique_contributed: 0 }, 'legC 返回的数据没进报告 = 纯浪费');
});

test('CORE: 完全冗余的 source unique_contributed 为 0', () => {
  const obs = load();
  obs.startRun({ date: '2026-07-28' });
  const rec = (source, ids) => {
    const tk = obs.requestStart();
    obs.requestEnd(tk, { path: '/executions/2028/tasks', source, ok: true, body: { tasks: ids.map((id) => ({ id })) } });
  };
  rec('main', [1, 2, 3]);
  rec('redundant', [1, 2]); // 完全被 main 覆盖
  const c = obs.computeContribution([1, 2, 3]);
  assert.equal(c.redundant.unique_contributed, 0, '完全被覆盖的取法应显示为可砍');
  // main 的 1、2 也被 redundant 拿到,所以砍掉 main 只会丢 id=3 这一条。
  // unique_contributed 的语义是「砍掉它会丢多少」,不是「它拿到多少」。
  assert.equal(c.main.unique_contributed, 1);
  assert.equal(c.main.contributed, 3);
});

test('REGRESSION: 贡献度必须按「过滤后采纳」算,不是原始返回', () => {
  // 复现 2026-07-28 首次实跑暴露的指标缺陷:exec-tasks 三条腿返回的是同一
  // execution 的同一批任务(排序不同),原始 id 集合几乎全等 → 按返回算每条腿
  // unique 恒为 0,分析会输出"三腿全可砍",而探测实证 finishedDate 腿独有 6 条。
  const obs = load();
  obs.startRun({ date: '2026-07-28' });
  const rec = (source, returnedIds) => {
    const tk = obs.requestStart();
    obs.requestEnd(tk, { path: '/executions/2028/tasks', source, ok: true, body: { tasks: returnedIds.map((id) => ({ id })) } });
  };
  // 三条腿都"返回"了 1..5(同一批任务的不同排序)
  rec('legLastEdited', [1, 2, 3, 4, 5]);
  rec('legOpened', [1, 2, 3, 4, 5]);
  rec('legFinished', [1, 2, 3, 4, 5]);
  // 但各自的窗口过滤只采纳了不同子集 —— 这才是三腿真正的差异
  obs.adopt('legLastEdited', [1, 2]);
  obs.adopt('legOpened', [2, 3]);
  obs.adopt('legFinished', [4, 5]); // 独有 4,5 —— 砍掉就丢 2 条

  const c = obs.computeContribution([1, 2, 3, 4, 5]);
  assert.equal(c.legFinished.unique_contributed, 2,
    'REGRESSION: 按原始返回算会得到 0,进而误判「三腿全可砍」');
  assert.equal(c.legLastEdited.unique_contributed, 1, '独有 id=1');
  assert.equal(c.legOpened.unique_contributed, 1, '独有 id=3');
});

test('REGRESSION: adopt([]) 表示「采纳 0 条」,不能退化成按原始返回计算', () => {
  // 探针未命中时它的 page1 被复用给 lastEditedDate 腿。若探针按原始返回记账,
  // 会吃掉那条腿的独有贡献,分析表上三腿集体显示"独有 0"(2026-07-28 实跑复现)。
  const obs = load();
  obs.startRun({ date: '2026-07-28' });
  const rec = (source, ids) => {
    const tk = obs.requestStart();
    obs.requestEnd(tk, { path: '/executions/2028/tasks', source, ok: true, body: { tasks: ids.map((id) => ({ id })) } });
  };
  rec('exec-tasks:probe', [1, 2, 3]); // 探针原始返回整页
  rec('legLastEdited', [1, 2, 3]);
  obs.adopt('exec-tasks:probe', []); // 未命中 → 采纳 0 条
  obs.adopt('legLastEdited', [1, 2, 3]);

  const c = obs.computeContribution([1, 2, 3]);
  assert.equal(c['exec-tasks:probe'].contributed, 0, '未命中的探针不该记贡献');
  assert.equal(c.legLastEdited.unique_contributed, 3,
    'REGRESSION: 探针若按原始返回记账会把这条腿的独有贡献吃成 0');
});

test('未调用 adopt 的 source 退化为按原始返回计算', () => {
  const obs = load();
  obs.startRun({ date: '2026-07-28' });
  const tk = obs.requestStart();
  obs.requestEnd(tk, { path: '/products/95/bugs?status=unclosed', source: 'bugs', ok: true, body: { bugs: [{ id: 7 }] } });
  const c = obs.computeContribution([7]);
  assert.equal(c.bugs.contributed, 1, '不做客户端过滤的端点应按返回计算');
});

test('lookup 角色写入 run 记录(避免查表被误判成浪费)', () => {
  const obs = load();
  obs.startRun({ date: '2026-07-28' });
  obs.markRole('/users', 'lookup');
  const tk = obs.requestStart();
  obs.requestEnd(tk, { path: '/users?limit=100', ok: true, body: { users: [{ id: 1 }] } });
  const rec = obs.finishRun({ exitCode: 0, payloadIds: [] });
  assert.equal(rec.by_source['/users'].role, 'lookup',
    'users/exec 归属/产品名这类查表的返回本就不进 payload,不能按贡献度判浪费');
});

// ---- 落盘 ---------------------------------------------------------------

test('实时落盘: 每条请求立刻可见,不等 finishRun', () => {
  const obs = load();
  obs.startRun({ date: '2026-07-28', product: 95 });
  const tk = obs.requestStart();
  obs.requestEnd(tk, { path: '/users?limit=100&page=1', ok: true, status: 200, body: { users: [{ id: 1 }], total: 184 } });

  const f = path.join(tmpDir, 'requests-2026-07-28.jsonl');
  assert.ok(fs.existsSync(f), 'finishRun 之前明细就必须已经在磁盘上(exit 4/SIGKILL 时才有据可查)');
  const line = JSON.parse(fs.readFileSync(f, 'utf-8').trim());
  assert.equal(line.path, '/users');
  assert.equal(line.rows, 1);
  assert.equal(line.total, 184);
  assert.equal(line.ok, true);
});

test('finishRun 写 runs.jsonl,含 by_source 聚合与退出码', () => {
  const obs = load();
  obs.startRun({ date: '2026-07-28', product: 95 });
  for (const ms of [10, 20, 30]) {
    const tk = obs.requestStart();
    obs.requestEnd(tk, { path: '/executions/2028/tasks?order=lastEditedDate_desc', ok: true, status: 200, body: { tasks: [{ id: ms }] } });
  }
  const rec = obs.finishRun({ exitCode: 0, apiCalls: 3, payloadIds: [10, 20, 30], counts: { tasks: 3 } });
  assert.equal(rec.exit_code, 0);
  const src = Object.keys(rec.by_source).find((s) => s.includes('lastEditedDate'));
  assert.equal(rec.by_source[src].calls, 3);
  assert.equal(rec.by_source[src].contributed, 3);
  assert.ok(fs.existsSync(path.join(tmpDir, 'runs.jsonl')));
});

test('失败的运行也必须留下 run 记录(exit 5 此前什么都不留)', () => {
  const obs = load();
  obs.startRun({ date: '2026-07-28', product: 95 });
  const tk = obs.requestStart();
  obs.requestEnd(tk, { path: '/products/95/stories?status=closedstory', ok: false, reason: 'This operation was aborted' });
  const rec = obs.finishRun({ exitCode: 5, skipped: [{ path: '/products/*/stories' }] });
  assert.equal(rec.exit_code, 5);
  const runs = obs.readRuns({ file: path.join(tmpDir, 'runs.jsonl') });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].exit_code, 5);
  const src = Object.keys(rec.by_source)[0];
  assert.equal(rec.by_source[src].failures.timeout, 1);
});

test('inflight 记录当时并发度(验证「并发=1」决策的唯一凭据)', () => {
  const obs = load();
  obs.startRun({ date: '2026-07-28' });
  const a = obs.requestStart();
  const b = obs.requestStart();
  obs.requestEnd(b, { path: '/executions/1/tasks', ok: true, body: {} });
  obs.requestEnd(a, { path: '/executions/2/tasks', ok: true, body: {} });
  const lines = fs.readFileSync(path.join(tmpDir, 'requests-2026-07-28.jsonl'), 'utf-8')
    .split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(lines[0].inflight, 2, '第二个请求发起时并发为 2');
  assert.equal(lines[1].inflight, 1);
});

// ---- 基线对比 -----------------------------------------------------------

test('基线对比用中位数,慢窗极端值不污染基线', () => {
  const obs = load();
  const history = [
    { by_source: { X: { ms_p95: 4000 } } },
    { by_source: { X: { ms_p95: 4200 } } },
    { by_source: { X: { ms_p95: 59000 } } }, // 慢窗离群点
    { by_source: { X: { ms_p95: 3900 } } },
  ];
  const cur = { by_source: { X: { ms_p95: 12000 } } };
  const cmp = obs.compareToBaseline(cur, history, { source: 'X', metric: 'ms_p95' });
  assert.ok(cmp.baseline < 10000, `中位数基线不该被 59s 离群点带偏,实际 ${cmp.baseline}`);
  assert.ok(cmp.deltaPct > 100);
});

test('healthLine 生成 announce 用的一行摘要', () => {
  const obs = load();
  const rec = {
    duration_ms: 458000,
    api_calls: 52,
    by_source: {
      '/executions/*/tasks|order=lastEditedDate_desc': { ms_p95: 59300, retries: 2, failures: { timeout: 2 } },
      '/users': { ms_p95: 2800, retries: 0 },
    },
  };
  const line = obs.healthLine(rec, []);
  assert.match(line, /458s/);
  assert.match(line, /API 52/);
  assert.match(line, /重试 2/);
  assert.match(line, /超时 2/);
  assert.match(line, /59\.3s/);
});

// ---- 鲁棒性(监控不能成为故障源) ----------------------------------------

test('SAFETY: 日志目录不可写时静默降级,不抛异常', () => {
  // 用「已存在的普通文件」当目录 —— mkdirSync 必然 ENOTDIR/EEXIST,
  // 且 Linux/macOS 行为一致。(早先用 /proc/... 会把 node v24 的测试
  // 运行器挂住 60s,平台差异导致的假故障。)
  const blocker = path.join(tmpDir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  process.env.EXP_COMPASS_LOG_DIR = path.join(blocker, 'logs');
  delete require.cache[require.resolve('../references/scripts/lib/obs.js')];
  const obs = require('../references/scripts/lib/obs.js');
  assert.doesNotThrow(() => {
    obs.startRun({ date: '2026-07-28' });
    const tk = obs.requestStart();
    obs.requestEnd(tk, { path: '/users', ok: true, body: {} });
    obs.finishRun({ exitCode: 0 });
  }, '监控故障绝不能拖垮采集');
});

test('SAFETY: 畸形响应体不影响记录', () => {
  const obs = load();
  obs.startRun({ date: '2026-07-28' });
  assert.doesNotThrow(() => {
    const tk = obs.requestStart();
    obs.requestEnd(tk, { path: '/users', ok: true, body: 'this is not an object' });
  });
});

test('SAFETY: EXP_COMPASS_OBS=0 时完全关闭', () => {
  process.env.EXP_COMPASS_OBS = '0';
  delete require.cache[require.resolve('../references/scripts/lib/obs.js')];
  const obs = require('../references/scripts/lib/obs.js');
  obs.startRun({ date: '2026-07-28' });
  const tk = obs.requestStart();
  obs.requestEnd(tk, { path: '/users', ok: true, body: {} });
  assert.equal(obs.finishRun({ exitCode: 0 }), null);
  assert.equal(fs.existsSync(path.join(tmpDir, 'requests-2026-07-28.jsonl')), false);
  delete process.env.EXP_COMPASS_OBS;
});
