'use strict';
// 2026-07-27:Phase 1 的 project → executions 走查必须显式带 limit。
//
// 起因:排查 7-26 cron 失败时顺带发现 —— collect-weekly.js 的
// `/projects/{id}/executions` 没带 limit,而禅道 v1 不带 limit 时默认只回
// 20 条且**不报错**([[project-zentao-pagination-pitfalls]])。
// product 95 下 3 个 VOC 主项目的 execution 数分别是 30/29/26,实测因此
// 静默丢掉 25 个 execution(112 → 87)。
//
// 当时没炸只是运气:禅道默认按 id 倒序返回,被截掉的 25 个恰好都是
// 2024-2026 上半年的历史迭代。一旦排序方向或迭代新建顺序变化,丢的就是
// 当周迭代 —— 周报会静默少报任务且无任何痕迹。
//
// 同理修 `/products/{id}/projects`(当前 13 个未触顶,但同样脆弱)。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../references/scripts/collect-weekly.js');

// 该 project 下挂 30 个 execution —— 超过禅道不带 limit 时的 20 条默认上限。
const EXEC_COUNT = 30;
const PROJ_ID = 2023;

let server;
let baseUrl;
let cacheDir;
let seenExecIds;

// 假禅道复刻真实行为:不带 limit 就只回前 20 条,且不报错、不提示截断。
function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const rawLimit = u.searchParams.get('limit');
  const json = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (p === '/users') return json({ users: [{ account: 'qingwa', realname: '青蛙' }], total: 1 });
  if (p === '/user') return json({ profile: { account: 'qingwa' } });

  if (p === '/products/95/projects') {
    return json({ projects: [{ id: PROJ_ID }], total: 1 });
  }

  if (p === `/projects/${PROJ_ID}/executions`) {
    const all = [];
    for (let i = 1; i <= EXEC_COUNT; i++) {
      all.push({ id: 9000 + i, name: `sprint-${i}`, status: 'doing', begin: '2026-07-20', end: '2026-07-26' });
    }
    const effective = rawLimit ? Number(rawLimit) : 20; // 禅道默认 20
    return json({ executions: all.slice(0, effective), total: EXEC_COUNT });
  }

  const execTasks = /^\/executions\/(\d+)\/tasks$/.exec(p);
  if (execTasks) {
    seenExecIds.add(Number(execTasks[1]));
    return json({ tasks: [], total: 0 });
  }

  if (p === '/products/95/bugs') return json({ bugs: [], total: 0 });
  return json({ error: 'not found' }, 404);
}

before(async () => {
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-exec-'));
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({ token: 'fake-token' }));
});

after(() => {
  server.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

function runCollect() {
  const out = path.join(cacheDir, 'out.json');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--out', out], {
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

test('project 下超过 20 个 execution 时全部扫到,不被默认分页静默截断', async () => {
  seenExecIds = new Set();
  const r = await runCollect();

  assert.equal(r.status, 0, `采集应成功。stderr: ${r.stderr}`);
  assert.equal(seenExecIds.size, EXEC_COUNT,
    `${EXEC_COUNT} 个 execution 必须全部走查,实际只扫了 ${seenExecIds.size} 个 `
    + '—— 不带 limit 时禅道默认只回 20 条且不报错');
  assert.match(r.stdout, new RegExp(`total executions to scan: ${EXEC_COUNT}`),
    'trace 行必须反映真实的 execution 总数');
});
