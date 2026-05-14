'use strict';
// E2E suite for collect.js.
//
// Each test starts a mock Zentao HTTP server, points ZENTAO_BASE_URL at
// it, and spawns the real collect.js as a child process. Asserts on the
// JSON output, exit code, and _meta.skipped. This is the network-layer
// counterpart to the unit tests under tests/run-*.js — those test pure
// helpers in isolation; this proves the full phase1→phase2→aggregate
// pipeline survives realistic failure shapes (503 retry, partial-OK
// union, all-fail per-exec skip).
//
// Why not mock fetch directly: the cron incident on 2026-05-13 lived in
// the *interaction* between phase2 batching, per-execution race, and
// scoped fetch — surface area that no single function-level mock could
// see. E2E uses a real HTTP server so AbortController, retry/backoff,
// and concurrency are exercised the same way they are in production.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { startMockServer } = require('./mock-zentao-server.js');
const { happyScenario, TEST_DATE, HAPPY_EXPECTED_SUMMARY } = require('./fixtures/happy.js');

const COLLECT_JS = path.resolve(__dirname, '..', '..', 'references', 'scripts', 'collect.js');
const SUBPROC_TIMEOUT_MS = 60_000;

function spawnCollectAsync(args, opts) {
  // Async spawn is mandatory here: spawnSync blocks the event loop, which
  // prevents the in-process mock HTTP server from handling requests.
  // The child TCP-connects successfully but the parent never gets to fire
  // the 'request' event, and every fetch hangs until AbortController aborts.
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, opts);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, SUBPROC_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ status: code, signal, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(killTimer);
      reject(e);
    });
  });
}

async function runCollectAgainstMock(scenario, { date = TEST_DATE, productId = '95', extraEnv = {} } = {}) {
  const mock = await startMockServer(scenario);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-compass-e2e-'));
  // Pre-seed token cache so collect.js skips the zt-functions.sh bash bridge.
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
      ...extraEnv,
    };
    const proc = await spawnCollectAsync([
      COLLECT_JS,
      '--product', productId,
      '--date', date,
      '--out', outFile,
    ], { env });
    const output = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf-8')) : null;
    return {
      exitCode: proc.status,
      stdout: proc.stdout || '',
      stderr: proc.stderr || '',
      output,
      calls: mock.calls.slice(),
    };
  } finally {
    await mock.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('T1 happy path: 1 product, 2 execs, 5 tasks → all 12 summary buckets correct', async () => {
  const scenario = happyScenario();
  const result = await runCollectAgainstMock({ routes: scenario.routes });
  assert.equal(result.exitCode, 0, `collect.js exited ${result.exitCode}; stderr:\n${result.stderr}`);
  assert.ok(result.output, 'expected output JSON');
  assert.deepEqual(result.output.summary.story, HAPPY_EXPECTED_SUMMARY.story, 'story summary mismatch');
  assert.deepEqual(result.output.summary.task, HAPPY_EXPECTED_SUMMARY.task, 'task summary mismatch');
  assert.deepEqual(result.output.summary.bug, HAPPY_EXPECTED_SUMMARY.bug, 'bug summary mismatch');
  assert.deepEqual(result.output._meta.skipped, [], 'no routes should be skipped on happy path');
  assert.equal(result.output._meta.budget_exceeded, false);
  assert.equal(result.output._meta.wall_clock_early_exit, false);
});

test('T2 partial-OK: 1 of 3 desc queries returns 503 — union still covers tasks', async () => {
  const scenario = happyScenario();
  // Knock out finishedDate_desc for exec 1001. The other two desc queries
  // still return T501/T502/T503, so the union dedup keeps full coverage.
  const inject = {
    'GET /executions/1001/tasks?limit=100&order=finishedDate_desc&page=1': { status: 503 },
  };
  const result = await runCollectAgainstMock({ routes: scenario.routes, inject });
  assert.equal(result.exitCode, 0, `collect.js exited ${result.exitCode}; stderr:\n${result.stderr}`);
  assert.ok(result.output, 'expected output JSON');
  // Task summary should be unchanged from happy path — the other two
  // desc queries cover the same task set.
  assert.deepEqual(result.output.summary.task, HAPPY_EXPECTED_SUMMARY.task, 'task summary should match happy path despite 1/3 query failing');
  // STATE.skipped should record exactly one fetchScoped failure.
  const fetchFails = result.output._meta.skipped.filter((s) => s.queryParam === 'order=finishedDate_desc');
  assert.equal(fetchFails.length, 1, `expected exactly 1 finishedDate_desc skip entry, got ${fetchFails.length}: ${JSON.stringify(result.output._meta.skipped)}`);
  // And NO scoped-fetch-failed entry should be present (union succeeded).
  const totalExecFails = result.output._meta.skipped.filter((s) => s.reason === 'scoped-fetch-failed');
  assert.equal(totalExecFails.length, 0, 'union succeeded, no scoped-fetch-failed expected');
});

test('T3 per-exec total failure: all 3 desc queries for exec 1002 return 503 — siblings preserved', async () => {
  const scenario = happyScenario();
  const inject = {
    'GET /executions/1002/tasks?limit=100&order=openedDate_desc&page=1': { status: 503 },
    'GET /executions/1002/tasks?limit=100&order=finishedDate_desc&page=1': { status: 503 },
    'GET /executions/1002/tasks?limit=100&order=lastEditedDate_desc&page=1': { status: 503 },
  };
  const result = await runCollectAgainstMock({ routes: scenario.routes, inject });
  assert.equal(result.exitCode, 0, `collect.js exited ${result.exitCode}; stderr:\n${result.stderr}`);
  assert.ok(result.output, 'expected output JSON');
  // Exec 1001 (T501-T503) should still flow through; only T504, T505 lost.
  // T501 was today_new — still 1. T502 still today_done. T503 still in_progress.
  // T505 (in_progress) is gone, T504 (todo) is gone.
  assert.equal(result.output.summary.task.today_new, 1, 'T501 should still count');
  assert.equal(result.output.summary.task.today_done, 1, 'T502 should still count');
  assert.equal(result.output.summary.task.in_progress, 2, 'T501+T503 only (T505 lost); got tasks summary=' + JSON.stringify(result.output.summary.task));
  assert.equal(result.output.summary.task.todo, 0, 'T504 lost');
  // STATE.skipped: 3 fetchScoped failures + 1 scoped-fetch-failed marker.
  const execSkips = result.output._meta.skipped.filter((s) => s.reason === 'scoped-fetch-failed');
  assert.equal(execSkips.length, 1, 'expected 1 scoped-fetch-failed marker for exec 1002');
  assert.deepEqual(execSkips[0].executions, [1002]);
});

test('T4 budget exhaustion: tiny API budget short-circuits phase2', async () => {
  // Sets EXP_COMPASS_API_BUDGET to a value that lets phase1 finish but
  // starves phase2. Proves the budget gate triggers without timing out
  // on real HTTP, and that the JSON still serializes cleanly.
  const scenario = happyScenario();
  const result = await runCollectAgainstMock(
    { routes: scenario.routes },
    { extraEnv: { EXP_COMPASS_API_BUDGET: '8' } }, // phase1 consumes 7-8 calls; phase2 then hits budget
  );
  assert.equal(result.exitCode, 0, `collect.js exited ${result.exitCode}; stderr:\n${result.stderr}`);
  assert.ok(result.output, 'expected output JSON');
  assert.equal(result.output._meta.budget_exceeded, true, 'budget gate should have flipped');
  assert.ok(result.output._meta.skipped.some((s) => s.reason === 'budget'), 'expected at least one budget skip');
  assert.ok(Array.isArray(result.output.stories), 'stories array should exist');
  assert.ok(Array.isArray(result.output.bugs), 'bugs array should exist');
});
