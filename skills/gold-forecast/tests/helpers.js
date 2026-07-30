'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SCRIPT = (name) => path.join(__dirname, '..', 'references', 'scripts', name);
const FIXTURE = (name) => path.join(__dirname, 'fixtures', name);
const BLOCK_NETWORK = path.join(__dirname, 'helpers', 'block-network.js');

// 拼接而非赋值:调用方自己的 NODE_OPTIONS 保留,shim 永远追加在最后
const withBlockNetwork = (existing) => [existing, `--require ${BLOCK_NETWORK}`].filter(Boolean).join(' ');

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gold-test-'));
}

// 运行脚本 CLI。HOME 指向临时目录,避免污染真实状态目录。
// 一律注入断网 shim:子进程不继承 runner 的 NODE_OPTIONS(这里给的是白名单 env),
// 漏传 --fixture 的测试会当场报 [NET-BLOCKED],而不是静默打真实端点。
function runCli({ script, args = [], env = {}, stdin = null, timeout = 30_000 }) {
  const tmp = freshTmp();
  // NODE_OPTIONS 必须排在 ...env **之后**并做拼接而非赋值:放前面时调用方传一个
  // env.NODE_OPTIONS 就会静默顶掉 shim,而"靠自觉守不住"正是加这层的理由。
  const fullEnv = { PATH: process.env.PATH, HOME: tmp, ...env, NODE_OPTIONS: withBlockNetwork(env.NODE_OPTIONS) };
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

module.exports = { SCRIPT, FIXTURE, runCli, freshTmp, BLOCK_NETWORK, withBlockNetwork };
