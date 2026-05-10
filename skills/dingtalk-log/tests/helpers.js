'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'dingtalk-log.js');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-test-'));
}

// 启动 CLI 子进程,fetchMockPath 指向一个导出 fetch 函数的 .js 文件
function runCli({ args = [], env = {}, stdin = null, fetchMockPath = null, isTty = false }) {
  const tmpHome = freshHome();
  const fullEnv = {
    PATH: process.env.PATH,
    ...env,
    HOME: tmpHome,
  };
  if (fetchMockPath) fullEnv.DINGTALK_TEST_FETCH = fetchMockPath;
  if (isTty) fullEnv.DINGTALK_TEST_STDIN_TTY = '1';

  const r = spawnSync('node', [CLI, ...args], {
    env: fullEnv,
    input: stdin == null ? '' : stdin,
    encoding: 'utf-8',
    timeout: 90_000,
  });
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    home: tmpHome,
    cleanup: () => fs.rmSync(tmpHome, { recursive: true, force: true }),
  };
}

// 写一个临时的 fetch mock 文件,返回该文件路径
function writeFetchMock(home, body) {
  const file = path.join(home, 'fetch-mock.js');
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

module.exports = { CLI, freshHome, runCli, writeFetchMock };
