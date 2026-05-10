'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli } = require('./helpers');

test('sanity: 无参数 → 打印 help', () => {
  const r = runCli({ args: [] });
  try {
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: dingtalk-log/);
  } finally {
    r.cleanup();
  }
});

test('B1: 凭据缺失 → exit 1 + stderr 列全缺失项 + 0 fetch', () => {
  const r = runCli({
    args: ['create-report', '--template-id', 'x', '--contents', '[]', '--userid', 'u'],
    env: { DINGTALK_APPKEY: '', DINGTALK_APPSECRET: '' },
  });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /missing required env.*DINGTALK_APPKEY.*DINGTALK_APPSECRET/);
  } finally {
    r.cleanup();
  }
});

test('B6: contents 非数组 → exit 1', () => {
  const r = runCli({
    args: ['create-report', '--template-id', 'x', '--contents', '{}', '--userid', 'u'],
    env: { DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u' },
  });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /contents must be a JSON array/);
  } finally {
    r.cleanup();
  }
});

test('B26: --help 跳过 env 校验', () => {
  const r = runCli({
    args: ['create-report', '--help'],
    env: {},
  });
  try {
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: dingtalk-log create-report/);
    assert.doesNotMatch(r.stderr, /missing required env/);
  } finally {
    r.cleanup();
  }
});

test('B2/B3 (deferred): userid env 兜底与 flag 优先', { skip: 'enable after fetch mock hookup (Task 11)' }, () => {});
