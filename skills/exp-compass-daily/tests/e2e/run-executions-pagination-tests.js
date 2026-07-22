'use strict';
// Spec tests for the 2026-07-23 executions-pagination fix in collect.js:
//
// 线上实证(2026-07-22 seq 81 成功 run 漏任务):`/projects/{id}/executions`
// 用单次 ztFetch 拉取,禅道 v1 默认 limit=20,项目 3084/2353/1845 实际
// total 29/30/26 → 25 个 execution 被静默截断,其下任务全部丢失且不进
// STATE.skipped(collect exit 0"成功")。修复:改走 ztPaginate 翻页取齐,
// page1 失败也会进 skipped → 物理断路 fatal 可见。
//
// NOTE: helper 镜像自 run-e2e-tests.js(那套 fixture 期望在 V4 后已过时,
// 整体重写时应把本文件的 helper 合并过去)。

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
  const single = routes['GET /projects/3084/executions'];
  delete routes['GET /projects/3084/executions'];
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
