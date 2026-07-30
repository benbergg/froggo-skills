'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SCRIPT = (name) => path.join(__dirname, '..', 'references', 'scripts', name);
const FIXTURE = (name) => path.join(__dirname, 'fixtures', name);
const BLOCK_NETWORK = path.join(__dirname, 'helpers', 'block-network.js');

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gold-test-'));
}

// 运行脚本 CLI。HOME 指向临时目录,避免污染真实状态目录。
// 一律注入断网 shim:子进程不继承 runner 的 NODE_OPTIONS(这里给的是白名单 env),
// 漏传 --fixture 的测试会当场报 [NET-BLOCKED],而不是静默打真实端点。
function runCli({ script, args = [], env = {}, stdin = null, timeout = 30_000 }) {
  const tmp = freshTmp();
  const fullEnv = { PATH: process.env.PATH, HOME: tmp, NODE_OPTIONS: `--require ${BLOCK_NETWORK}`, ...env };
  // cwd 定为 tmp,使 CLI 参数里的相对路径(如 --out out.json)落在隔离目录内。
  const opts = { env: fullEnv, encoding: 'utf-8', timeout, cwd: tmp };
  if (stdin !== null) opts.input = stdin;
  const r = spawnSync('node', [SCRIPT(script), ...args], opts);
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

module.exports = { SCRIPT, FIXTURE, runCli, freshTmp, BLOCK_NETWORK };
