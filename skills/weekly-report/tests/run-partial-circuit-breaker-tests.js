'use strict';
// 2026-07-27 端到端断路测试:丢页必须让进程非零退出。
//
// 单测 assertDataComplete 只能证明判定逻辑对,证明不了它被接到 main 上。
// 7-26 cron seq 29 的教训恰恰是"留痕了但没拦截"—— STATE.skipped 里明明记着
// bugs page=3 terminated,脚本仍然 exit 0 输出 "OK",下游弱模型据此继续写
// 周报并推送。所以这里起一个假禅道 server 跑真实 CLI,断言退出码。
//
// 参照 [[project-pipeline-physical-circuit-breaker]]:防线要做成物理断路,
// 不能只靠提示词或日志。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../references/scripts/collect-weekly.js');

const BUGS_TOTAL = 250; // limit=100 → 3 页,第 3 页用于制造丢页
let server;
let baseUrl;
let cacheDir;

// 假禅道:只实现 collect-weekly 走到的端点。bugs 第 3 页恒定 500,
// 触发 ztFetch 的重试耗尽 → { ok:false, reason:'http 500' }。
function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const page = Number(u.searchParams.get('page') || '1');
  const limit = Number(u.searchParams.get('limit') || '100');
  const json = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (p === '/users') return json({ users: [{ account: 'qingwa', realname: '青蛙' }], total: 1 });
  if (p === '/user') return json({ profile: { account: 'qingwa' } });
  if (p === '/products/95/projects') return json({ projects: [{ id: 2023 }], total: 1 });
  if (p === '/projects/2023/executions') return json({ executions: [{ id: 2028 }], total: 1 });
  if (p === '/executions/2028/tasks') return json({ tasks: [], total: 0 });

  if (p === '/products/95/bugs') {
    if (page === 3) return json({ error: 'injected tail latency' }, 500);
    const start = (page - 1) * limit;
    const bugs = [];
    for (let i = start; i < Math.min(start + limit, BUGS_TOTAL); i++) {
      bugs.push({ id: i + 1, status: 'active', title: `bug ${i + 1}`, openedDate: '2026-07-21 10:00:00' });
    }
    return json({ bugs, total: BUGS_TOTAL });
  }
  return json({ error: 'not found' }, 404);
}

before(async () => {
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-cb-'));
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({ token: 'fake-token' }));
});

after(() => {
  server.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

// 必须异步 spawn:假禅道 server 跑在本测试进程里,spawnSync 会阻塞
// event loop 导致 server 永远不响应,子进程只能一路 15s 超时。
function runCollect(extraArgs = []) {
  const out = path.join(cacheDir, `out-${extraArgs.join('_') || 'plain'}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--out', out, ...extraArgs], {
      env: {
        ...process.env,
        ZENTAO_BASE_URL: baseUrl,
        ZENTAO_ACCOUNT: 'test',
        ZENTAO_PASSWORD: 'test',
        ZENTAO_CACHE_DIR: cacheDir,
        ZENTAO_ME: 'qingwa',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr, outPath: out });
    });
  });
}

test('bugs 分页丢页时进程非零退出,不再 exit 0 输出残缺数据', async () => {
  const r = await runCollect();

  assert.notEqual(r.status, 0,
    `丢页必须物理断路。实际 exit=${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /FATAL/, 'stderr 必须给出 FATAL 说明');
  assert.match(r.stderr, /bugs/, '错误信息必须指出是哪个端点丢的页');
  assert.doesNotMatch(r.stdout, /^OK /m,
    '断路时不能再打印 "OK ..." —— 那正是 7-26 误导下游的那行');
});

test('--allow-partial 时放行并写出 JSON,由操作者承担残缺风险', async () => {
  const r = await runCollect(['--allow-partial']);

  assert.equal(r.status, 0,
    `--allow-partial 应放行。实际 exit=${r.status}\nstderr: ${r.stderr}`);
  assert.ok(fs.existsSync(r.outPath), 'JSON 必须写出');
  const payload = JSON.parse(fs.readFileSync(r.outPath, 'utf-8'));
  const dropped = payload._meta.skipped.filter((s) => s.reason !== 'budget');
  assert.ok(dropped.length > 0, '放行不等于抹掉证据,_meta.skipped 仍须留痕');
});

test('断路时仍写出 JSON 供诊断,与 budget_exceeded 分支行为一致', async () => {
  const r = await runCollect();
  assert.ok(fs.existsSync(r.outPath),
    '残缺 JSON 仍要落盘用于排查,非零 exit 已足够阻断下游');
});
