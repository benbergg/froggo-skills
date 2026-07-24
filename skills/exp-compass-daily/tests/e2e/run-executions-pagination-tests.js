'use strict';
// Spec tests for the 2026-07-23 executions-pagination fix in collect.js:
//
// 线上实证(2026-07-22 seq 81 成功 run 漏任务):`/projects/{id}/executions`
// 用单次 ztFetch 拉取,禅道 v1 默认 limit=20,项目 3084/2353/1845 实际
// total 29/30/26 → 25 个 execution 被静默截断,其下任务全部丢失且不进
// STATE.skipped(collect exit 0"成功")。修复:改走 ztPaginate 翻页取齐,
// page1 失败也会进 skipped → 物理断路 fatal 可见。
//
// NOTE: helper 自包含(V4 旧套件 run-e2e-tests.js 已删除),本文件即
// spawnCollectAsync helper 的唯一归属处。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { startMockServer } = require('./mock-zentao-server.js');
const { happyScenario, TEST_DATE } = require('./fixtures/happy.js');

const COLLECT_JS = path.resolve(__dirname, '..', '..', 'references', 'scripts', 'collect.js');
const SUBPROC_TIMEOUT_MS = 60_000;

function spawnCollectAsync(args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => { child.kill('SIGKILL'); }, SUBPROC_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on('error', (e) => { clearTimeout(killTimer); reject(e); });
  });
}

async function runCollectAgainstMock(scenario, { date = TEST_DATE } = {}) {
  const mock = await startMockServer(scenario);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-compass-e2e-pg-'));
  fs.writeFileSync(path.join(tmpDir, 'token.json'), JSON.stringify({ token: 'test-token' }));
  const outFile = path.join(tmpDir, `out-${date}.json`);
  try {
    const env = {
      ...process.env,
      ZENTAO_BASE_URL: mock.baseUrl,
      ZENTAO_ACCOUNT: 'test',
      ZENTAO_PASSWORD: 'test',
      ZENTAO_CACHE_DIR: tmpDir,
      EXP_COMPASS_VOC_PROJECT_IDS: '3084',
    };
    const proc = await spawnCollectAsync(
      [COLLECT_JS, '--product', '95', '--date', date, '--out', outFile],
      { env },
    );
    return {
      exitCode: proc.status,
      stderr: proc.stderr || '',
      output: fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf-8')) : null,
      partialExists: fs.existsSync(`${outFile}.partial`),
      calls: mock.calls.slice(),
    };
  } finally {
    await mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 把 happy fixture 的单页 executions 路由改造成两页:page1 只含 exec 1001,
// total=101(> limit 100)迫使 ztPaginate 请求 page2 才能拿到 exec 1002。
function paginatedScenario() {
  const scenario = happyScenario();
  const routes = { ...scenario.routes };
  const single = routes['GET /projects/3084/executions?limit=100&page=1'];
  delete routes['GET /projects/3084/executions?limit=100&page=1'];
  const [exec1001, exec1002] = single.executions;
  routes['GET /projects/3084/executions?limit=100&page=1'] = {
    executions: [exec1001], total: 101, limit: 100, page: 1,
  };
  routes['GET /projects/3084/executions?limit=100&page=2'] = {
    executions: [exec1002], total: 101, limit: 100, page: 2,
  };
  return { routes };
}

test('P1 executions 翻页取齐: 两页 execution 的任务都被拉取', async () => {
  const result = await runCollectAgainstMock(paginatedScenario());
  assert.equal(result.exitCode, 0, `collect.js exited ${result.exitCode}; stderr:\n${result.stderr}`);
  assert.ok(
    result.calls.some((c) => c.includes('/projects/3084/executions?') && c.includes('page=1')),
    `expected paginated executions page=1 call, got:\n${result.calls.join('\n')}`,
  );
  assert.ok(
    result.calls.some((c) => c.includes('/projects/3084/executions?') && c.includes('page=2')),
    'expected executions page=2 call (total=101 > limit=100)',
  );
  // 第 2 页的 execution(1002) 的任务也必须被拉 —— 截断 bug 下这里不会发生
  assert.ok(
    result.calls.some((c) => c.includes('/executions/1001/tasks')),
    'expected tasks fetch for exec 1001 (page 1)',
  );
  assert.ok(
    result.calls.some((c) => c.includes('/executions/1002/tasks')),
    'expected tasks fetch for exec 1002 (page 2) — lost under the limit=20 truncation bug',
  );
});

test('P2 executions page1 失败: 进 skipped → exit 2 + 物理断路(无正式 JSON)', async () => {
  const scenario = paginatedScenario();
  scenario.inject = {
    'GET /projects/3084/executions?limit=100&page=1': { status: 503 },
  };
  const result = await runCollectAgainstMock(scenario);
  assert.equal(result.exitCode, 2, `expected exit 2 (source skipped), got ${result.exitCode}; stderr:\n${result.stderr}`);
  assert.equal(result.output, null, '正式路径不应有 JSON(物理断路)');
  assert.equal(result.partialExists, true, 'partial JSON 应落 *.partial 供诊断');
  assert.match(result.stderr, /FATAL.*skipped/s);
});

// ---------------------------------------------------------------------------
// 2026-07-23 VOC 降级分流测试组
//
// 7425d29 把所有 skip 一刀切 fatal,与 b7e92e6 executions 取齐叠加:晚间
// 禅道慢速时非 VOC 借派迭代超时 → 整轮中止(07-23 晚三连败)。恢复
// 05-13「预算耗尽牺牲非 VOC」语义:非 VOC exec 级 skip → 可见降级
// (_meta.degraded_non_voc + exit 0);产品级数据源或 VOC 迭代 skip 仍 fatal。
// ---------------------------------------------------------------------------

// happy fixture 上加一个非 VOC 项目(9999)及其 execution 8001。
// EXP_COMPASS_VOC_PROJECT_IDS='3084' → 8001 非 VOC 所属。
//
// 2026-07-24 V5 适配:main() 不再查 /products/95/projects,project→execution
// 遍历已被 story 反查取代。要让 exec 8001 进入 candidateExecIds(否则它永
// 远不会被 fetch,P3/P4 的失败注入就测不到任何东西),story 100 需关联到
// 8001 —— 与 V5-1 的借派 task 场景同一叙事:8001 是挂在 VOC story 下的
// 跨部门(非白名单项目)execution。
function withNonVocProject() {
  const scenario = happyScenario();
  const routes = { ...scenario.routes };
  routes['GET /stories/100'] = {
    id: 100,
    executions: { 1001: { status: 'doing' }, 8001: { status: 'doing' } },
  };
  routes['GET /projects/9999/executions?limit=100&page=1'] = {
    executions: [{ id: 8001, name: '借派 Sprint', status: 'doing', products: [95] }],
    total: 1, limit: 100, page: 1,
  };
  for (const order of ['openedDate_desc', 'finishedDate_desc', 'lastEditedDate_desc']) {
    routes[`GET /executions/8001/tasks?limit=100&order=${order}&page=1`] = { tasks: [], total: 0 };
  }
  return { routes };
}

test('P3 非 VOC exec 任务查询失败: 降级不中止 → exit 0 + 正式 JSON + degraded_non_voc', async () => {
  const scenario = withNonVocProject();
  scenario.inject = {
    'GET /executions/8001/tasks?limit=100&order=lastEditedDate_desc&page=1': { status: 503 },
    'GET /executions/8001/tasks?limit=100&order=openedDate_desc&page=1': { status: 503 },
    'GET /executions/8001/tasks?limit=100&order=finishedDate_desc&page=1': { status: 503 },
  };
  const result = await runCollectAgainstMock(scenario);
  assert.equal(result.exitCode, 0,
    `non-VOC exec failure must degrade, not abort; got exit ${result.exitCode}; stderr:\n${result.stderr}`);
  assert.ok(result.output, '正式 JSON 必须存在(非 VOC 降级不触发物理断路)');
  assert.equal(result.partialExists, false, '不应产生 .partial');
  const degraded = result.output._meta.degraded_non_voc || [];
  assert.ok(degraded.length > 0, `_meta.degraded_non_voc 应记录降级明细,got: ${JSON.stringify(result.output._meta)}`);
  assert.ok(degraded.every((s) => {
    const ids = s.executions || [s.execId];
    return ids.every((id) => Number(id) === 8001);
  }), `降级条目应全部指向 exec 8001: ${JSON.stringify(degraded)}`);
  assert.equal((result.output._meta.skipped || []).length, 0, 'critical skipped 应为空');
  // VOC 数据完整性:degraded 不影响 happy 数据集
  assert.ok(result.output.stories.length > 0, 'VOC stories 不受降级影响');
});

test('P4 VOC exec 任务查询失败: 仍然 fatal → exit 2 + 物理断路', async () => {
  const scenario = withNonVocProject();
  scenario.inject = {
    'GET /executions/1001/tasks?limit=100&order=lastEditedDate_desc&page=1': { status: 503 },
    'GET /executions/1001/tasks?limit=100&order=openedDate_desc&page=1': { status: 503 },
    'GET /executions/1001/tasks?limit=100&order=finishedDate_desc&page=1': { status: 503 },
  };
  const result = await runCollectAgainstMock(scenario);
  assert.equal(result.exitCode, 2,
    `VOC exec failure must stay fatal; got exit ${result.exitCode}; stderr:\n${result.stderr}`);
  assert.equal(result.output, null, '正式路径不应有 JSON(物理断路)');
  assert.equal(result.partialExists, true, 'partial JSON 应落 *.partial');
});

// ---------------------------------------------------------------------------
// 2026-07-24 V5 story-driven 端到端
// ---------------------------------------------------------------------------

// 在 happy 基础上加一个跨部门项目 9999 及其 exec 8001(挂 story 100 的借派
// task 8501)。story 100 的详情 executions 含 8001 → story-driven 应命中 8001,
// 且完全不遍历 project 9999 的 executions 列表(反向定位不查项目)。
function crossTeamScenario() {
  const scenario = happyScenario();
  const routes = { ...scenario.routes };
  // story 100 关联到跨部门 exec 8001(借派)
  routes['GET /stories/100'] = { id: 100, executions: { 1001: { status: 'doing' }, 8001: { status: 'doing' } } };
  // 跨部门 exec 8001 的 task(挂 VOC story 100)
  const borrowed = { id: 8501, name: '借派 task', status: 'done', openedDate: '2026-05-13 09:00:00', finishedDate: '2026-05-20 11:00:00', story: 100, parent: 0, assignedTo: 'qingwa', lastEditedDate: '2026-05-20 11:00:00', execution: 8001 };
  for (const order of ['openedDate_desc', 'finishedDate_desc', 'lastEditedDate_desc']) {
    routes[`GET /executions/8001/tasks?limit=100&order=${order}&page=1`] = { tasks: [borrowed], total: 1 };
  }
  return { routes };
}

test('V5-1 借派 task:story 关联的跨部门 exec 8001 的 task 被捞到', async () => {
  const result = await runCollectAgainstMock(crossTeamScenario());
  assert.equal(result.exitCode, 0, `stderr:\n${result.stderr}`);
  const taskIds = (result.output.stories.find((s) => s.id === 100)?.tasks || []).map((t) => t.id);
  assert.ok(taskIds.includes(8501), `跨部门借派 task 8501 应被 story-driven 捞到,实际 ${taskIds}`);
});

test('V5-2 不遍历跨部门:未挂 story 的项目 executions 列表不被请求', async () => {
  const result = await runCollectAgainstMock(crossTeamScenario());
  // story-driven 不查任何 /projects/{非白名单}/executions
  const projCalls = result.calls.filter((c) => /\/projects\/9999\/executions/.test(c));
  assert.equal(projCalls.length, 0, `不应请求跨部门项目 executions 列表,实际:${projCalls}`);
  // 锁死"不回退全遍历":即使 mock 场景本就没定义 /products/95/projects,
  // 也要显式断言 collect.js 没有请求过它——防止有人重新引入 project 全遍历。
  const productProjectsCalls = result.calls.filter((c) => /\/products\/95\/projects/.test(c));
  assert.equal(productProjectsCalls.length, 0, `不应请求 /products/95/projects,实际:${productProjectsCalls}`);
});

test('V5-3 story 详情失败 → exit 2 + 物理断路(无正式 JSON)', async () => {
  const scenario = crossTeamScenario();
  scenario.inject = { 'GET /stories/100': { status: 503 } };
  const result = await runCollectAgainstMock(scenario);
  assert.equal(result.exitCode, 2, `story 详情失败必须 fatal,实际 exit ${result.exitCode};stderr:\n${result.stderr}`);
  assert.equal(result.output, null, '正式路径不应有 JSON');
  assert.equal(result.partialExists, true, 'partial JSON 应落 *.partial');
});

// loose task 场景:白名单含 project 7777(充当 2023 角色),其 doing exec 7001
// 上有一个未挂 VOC story 的 loose task 7501(story=0)。没有任何 story.executions
// 指向 7001 → 只能靠 loose 兜底(EXP_COMPASS_LOOSE_BACKFILL_PROJECT_ID=7777)命中。
function looseBackfillScenario() {
  const scenario = happyScenario();
  const routes = { ...scenario.routes };
  routes['GET /projects/7777/executions?limit=100&page=1'] = {
    executions: [{ id: 7001, status: 'doing' }], total: 1, limit: 100, page: 1,
  };
  const loose = { id: 7501, name: 'loose 散活', status: 'doing', openedDate: '2026-05-20 09:00:00', finishedDate: null, story: 0, parent: 0, assignedTo: 'qingwa', lastEditedDate: '2026-05-20 10:00:00', execution: 7001 };
  for (const order of ['openedDate_desc', 'finishedDate_desc', 'lastEditedDate_desc']) {
    routes[`GET /executions/7001/tasks?limit=100&order=${order}&page=1`] = { tasks: [loose], total: 1 };
  }
  return { routes };
}

test('V5-4 loose 兜底:2023 角色项目的 doing exec 上的 loose task 被捞到', async () => {
  // 注:brief 原稿用 spawnSync 起子进程 —— spawnSync 会同步阻塞父进程事件
  // 循环,而 mock HTTP server 与测试跑在同一进程/同一事件循环上,阻塞期间
  // server 无法响应任何请求,导致子进程的每个 ztFetch 都空等到 15s 超时后
  // abort(实测 5 个源全部 "operation was aborted"、耗时 96s、exit 2)。这
  // 不是 fixture 问题,是测试代码本身的阻塞 bug —— 改用文件内既有的异步
  // spawnCollectAsync helper,自定义 env 覆盖白名单 + loose 兜底项目 id。
  const mock = await startMockServer(looseBackfillScenario());
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-compass-e2e-loose-'));
  fs.writeFileSync(path.join(tmpDir, 'token.json'), JSON.stringify({ token: 'test-token' }));
  const outFile = path.join(tmpDir, `out-${TEST_DATE}.json`);
  try {
    const env = {
      ...process.env,
      ZENTAO_BASE_URL: mock.baseUrl,
      ZENTAO_ACCOUNT: 'test',
      ZENTAO_PASSWORD: 'test',
      ZENTAO_CACHE_DIR: tmpDir,
      EXP_COMPASS_VOC_PROJECT_IDS: '3084,7777',
      EXP_COMPASS_LOOSE_BACKFILL_PROJECT_ID: '7777',
    };
    const proc = await spawnCollectAsync(
      [COLLECT_JS, '--product', '95', '--date', TEST_DATE, '--out', outFile],
      { env },
    );
    assert.equal(proc.status, 0, `stderr:\n${proc.stderr}`);
    const out = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    const looseIds = (out.loose_tasks || []).map((t) => t.id);
    assert.ok(looseIds.includes(7501), `loose task 7501 应被兜底捞到,实际 loose_tasks=${looseIds}`);
  } finally {
    await mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
