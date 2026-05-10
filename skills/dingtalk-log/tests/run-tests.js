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

test('B1: 凭据缺失 → exit 1 + stderr 列全缺失项', () => {
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

test('Issue-2 regression: unknown subcommand + --help → exit 1, not Usage', () => {
  const r = runCli({ args: ['nonsense', '--help'], env: {} });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown subcommand "nonsense"/);
    assert.doesNotMatch(r.stdout, /Usage: dingtalk-log nonsense/);
  } finally {
    r.cleanup();
  }
});

test('B2/B3 (deferred): userid env 兜底与 flag 优先', { skip: 'enable after fetch mock hookup (Task 11)' }, () => {});

test('B22: stdin TTY 拒绝 (--contents -)', () => {
  const r = runCli({
    args: ['create-report', '--template-id', 'x', '--contents', '-', '--userid', 'u'],
    env: { DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's' },
    isTty: true,
  });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /requires piped stdin \(got tty\)/);
  } finally {
    r.cleanup();
  }
});

test('B23: 双 - 冲突', () => {
  const r = runCli({
    args: ['create-report', '--template-id', 'x', '--contents', '-', '--to-userids', '-', '--userid', 'u'],
    env: { DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's' },
    stdin: '[]',
  });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /only one flag may consume stdin/);
  } finally {
    r.cleanup();
  }
});

test('B7: --dry-run 打印 payload 且 0 fetch', () => {
  const r = runCli({
    args: ['create-report', '--template-id', 'tpl1', '--contents', '[{"key":"a","sort":"0","type":"1","content_type":"markdown","content":"x"}]', '--userid', 'u9', '--dry-run'],
    env: { DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's' },
  });
  try {
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.create_report_param.template_id, 'tpl1');
    assert.equal(j.create_report_param.userid, 'u9');
    assert.equal(j.create_report_param.contents.length, 1);
    assert.equal(j.create_report_param.dd_from, 'openapi');
  } finally {
    r.cleanup();
  }
});

test('tokenCache: write then read round-trip', () => {
  const cli = require('../scripts/dingtalk-log.js');
  const tmpHome = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dt-cache-rt-'));
  const env = { HOME: tmpHome };
  try {
    assert.equal(cli.tokenCacheRead(env), null, 'no cache yet → null');
    cli.tokenCacheWrite(env, { access_token: 'tok_abc', expires_at: 9999999999 });
    const got = cli.tokenCacheRead(env);
    assert.deepEqual(got, { access_token: 'tok_abc', expires_at: 9999999999 });
  } finally {
    require('node:fs').rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('tokenCache: malformed JSON → null (graceful)', () => {
  const cli = require('../scripts/dingtalk-log.js');
  const tmpHome = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dt-cache-bad-'));
  const env = { HOME: tmpHome };
  try {
    const file = cli.tokenCachePath(env);
    require('node:fs').mkdirSync(require('node:path').dirname(file), { recursive: true });
    require('node:fs').writeFileSync(file, 'not-json{');
    assert.equal(cli.tokenCacheRead(env), null);
  } finally {
    require('node:fs').rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('tokenCache: missing fields → null', () => {
  const cli = require('../scripts/dingtalk-log.js');
  const tmpHome = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dt-cache-bad2-'));
  const env = { HOME: tmpHome };
  try {
    const file = cli.tokenCachePath(env);
    require('node:fs').mkdirSync(require('node:path').dirname(file), { recursive: true });
    require('node:fs').writeFileSync(file, JSON.stringify({ wrong: 'shape' }));
    assert.equal(cli.tokenCacheRead(env), null);
  } finally {
    require('node:fs').rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('tokenCache: invalidate removes file (idempotent)', () => {
  const cli = require('../scripts/dingtalk-log.js');
  const tmpHome = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'dt-cache-inv-'));
  const env = { HOME: tmpHome };
  try {
    cli.tokenCacheWrite(env, { access_token: 't', expires_at: 1 });
    cli.tokenCacheInvalidate(env);
    assert.equal(cli.tokenCacheRead(env), null);
    cli.tokenCacheInvalidate(env);  // 二次 invalidate 不抛
  } finally {
    require('node:fs').rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('tokenIsFresh: 60s safety margin', () => {
  const cli = require('../scripts/dingtalk-log.js');
  const now = 1000;
  assert.equal(cli.tokenIsFresh({ expires_at: 1100 }, now), true,  'expires_at - now = 100 > 60 → fresh');
  assert.equal(cli.tokenIsFresh({ expires_at: 1050 }, now), false, 'expires_at - now = 50 < 60 → stale');
  assert.equal(cli.tokenIsFresh(null, now), false);
});
