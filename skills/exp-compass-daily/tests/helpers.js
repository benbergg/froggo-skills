'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'references', 'scripts', 'build-draft.js');
const FIXTURE = (name) => path.join(__dirname, 'fixtures', name);

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exp-compass-test-'));
}

function runCli({ args = [], env = {} }) {
  const tmp = freshTmp();
  const fullEnv = { PATH: process.env.PATH, HOME: tmp, ...env };
  const r = spawnSync('node', [CLI, ...args], {
    env: fullEnv,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

module.exports = { CLI, FIXTURE, runCli, freshTmp };
