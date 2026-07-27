'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SCRIPT = (name) => path.join(__dirname, '..', 'references', 'scripts', name);
const FIXTURE = (name) => path.join(__dirname, 'fixtures', name);

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-talk-test-'));
}

// 运行脚本 CLI。HOME 指向临时目录，避免污染真实 ~/.cache。
function runCli({ script, args = [], env = {}, stdin = null }) {
  const tmp = freshTmp();
  const fullEnv = { PATH: process.env.PATH, HOME: tmp, ...env };
  const opts = { env: fullEnv, encoding: 'utf-8', timeout: 30_000 };
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

module.exports = { SCRIPT, FIXTURE, runCli, freshTmp };
