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

test('B2: userid 来自 env 兜底(create-report dry-run)', () => {
  const r = runCli({
    args: ['create-report', '--template-id', 'tpl1', '--contents', '[{"key":"a","sort":"0","type":"1","content_type":"markdown","content":"x"}]', '--dry-run'],
    env: { DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'env_user' },
  });
  try {
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.create_report_param.userid, 'env_user');
  } finally { r.cleanup(); }
});

test('B3: --userid flag 覆盖 env', () => {
  const r = runCli({
    args: ['create-report', '--template-id', 'tpl1', '--userid', 'flag_user', '--contents', '[{"key":"a","sort":"0","type":"1","content_type":"markdown","content":"x"}]', '--dry-run'],
    env: { DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'env_user' },
  });
  try {
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.create_report_param.userid, 'flag_user');
  } finally { r.cleanup(); }
});

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

function readCounter(file) {
  if (!require('node:fs').existsSync(file)) return { calls: [] };
  return JSON.parse(require('node:fs').readFileSync(file, 'utf-8'));
}

test('B8: token cache 命中 → 0 次 gettoken', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b8-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok_cached',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const counter = path.join(tmpHome, 'fc.json');
  const fetchMockPath = path.join(__dirname, 'fixtures', 'fetch-counter.js');
  const r = runCli({
    args: ['get-template', '--template-name', '日报', '--userid', 'u9'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u9',
      HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([{ body: { errcode: 0, result: { id: 'tid', fields: [], default_received_convs: [], default_receivers: [] } } }]),
      DINGTALK_TEST_FETCH_COUNTER: counter,
    },
    fetchMockPath,
  });
  try {
    const calls = readCounter(counter).calls;
    const gettokenCalls = calls.filter((c) => c === 'gettoken').length;
    assert.equal(gettokenCalls, 0, 'expected 0 gettoken calls, got ' + gettokenCalls);
    assert.equal(r.code, 0);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B9: token cache 过期 → 调 gettoken 1 次 + 业务 1 次', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b9-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok_expired',
    expires_at: Math.floor(Date.now() / 1000) - 100,
  }));
  const counter = path.join(tmpHome, 'fc.json');
  const fetchMockPath = path.join(__dirname, 'fixtures', 'fetch-counter.js');
  const r = runCli({
    args: ['get-template', '--template-name', '日报', '--userid', 'u9'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u9',
      HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([
        { body: { errcode: 0, access_token: 'tok_new', expires_in: 7200 } },
        { body: { errcode: 0, result: { id: 'tid', fields: [], default_received_convs: [], default_receivers: [] } } },
      ]),
      DINGTALK_TEST_FETCH_COUNTER: counter,
    },
    fetchMockPath,
  });
  try {
    const calls = readCounter(counter).calls;
    assert.deepEqual(calls, ['gettoken', 'getbyname']);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B24: cache 损坏 → 当作 miss 不 crash', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b24-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), 'not-a-json{');
  const counter = path.join(tmpHome, 'fc.json');
  const fetchMockPath = path.join(__dirname, 'fixtures', 'fetch-counter.js');
  const r = runCli({
    args: ['get-template', '--template-name', '日报', '--userid', 'u9'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u9',
      HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([
        { body: { errcode: 0, access_token: 'tok_new', expires_in: 7200 } },
        { body: { errcode: 0, result: { id: 'tid', fields: [], default_received_convs: [], default_receivers: [] } } },
      ]),
      DINGTALK_TEST_FETCH_COUNTER: counter,
    },
    fetchMockPath,
  });
  try {
    assert.equal(r.code, 0);
    const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, 'token.json'), 'utf-8'));
    assert.equal(cached.access_token, 'tok_new');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B10: 业务 errcode 42001 → 重取 token 后业务重试 = 0;fetch 总数 = 3', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b10-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok_old',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const counter = path.join(tmpHome, 'fc.json');
  const r = runCli({
    args: ['get-template', '--template-name', '日报', '--userid', 'u9'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u9',
      HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([
        { body: { errcode: 42001, errmsg: 'access_token expired' } },
        { body: { errcode: 0, access_token: 'tok_new', expires_in: 7200 } },
        { body: { errcode: 0, result: { id: 'tid', fields: [], default_received_convs: [], default_receivers: [] } } },
      ]),
      DINGTALK_TEST_FETCH_COUNTER: counter,
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 0);
    const calls = readCounter(counter).calls;
    assert.deepEqual(calls, ['getbyname', 'gettoken', 'getbyname']);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B11: 重试后业务仍 42001 → exit 4 (get-template);fetch 总数 = 3,不再重试', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b11-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok_old',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const counter = path.join(tmpHome, 'fc.json');
  const r = runCli({
    args: ['get-template', '--template-name', '日报', '--userid', 'u9'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u9',
      HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([
        { body: { errcode: 42001 } },
        { body: { errcode: 0, access_token: 'tok_new', expires_in: 7200 } },
        { body: { errcode: 42001 } },
      ]),
      DINGTALK_TEST_FETCH_COUNTER: counter,
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 4);
    const calls = readCounter(counter).calls;
    assert.deepEqual(calls, ['getbyname', 'gettoken', 'getbyname']);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B12: 业务 errcode 88 不重试 → exit 4 + 1 业务调用', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b12-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok_old',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const counter = path.join(tmpHome, 'fc.json');
  const r = runCli({
    args: ['get-template', '--template-name', '日报', '--userid', 'u9'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u9',
      HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([
        { body: { errcode: 88, errmsg: 'template field mismatch' } },
      ]),
      DINGTALK_TEST_FETCH_COUNTER: counter,
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 4);
    const calls = readCounter(counter).calls;
    assert.deepEqual(calls, ['getbyname']);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B13: 网络错误 → exit 4 + stderr 不含明文凭据', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b13-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok_secret_xyz',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const r = runCli({
    args: ['get-template', '--template-name', '日報', '--userid', 'u9'],
    env: {
      DINGTALK_APPKEY: 'appkey_xyz', DINGTALK_APPSECRET: 'secret123',
      DINGTALK_USERID: 'u9', HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([{ throw: 'connection refused at appsecret=secret123' }]),
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 4);
    assert.doesNotMatch(r.stderr, /secret123/);
    assert.doesNotMatch(r.stderr, /tok_secret_xyz/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B14: sanitize 三形态(query/JSON/Bearer)', () => {
  const cli = require('../scripts/dingtalk-log.js');
  const cases = [
    'access_token=bE3xxxx',
    '"access_token":"bE3xxxx"',
    'appsecret=secret123&corp=xxx',
    '"appsecret":"secret123"',
    'Bearer bE3xxxx',
    'appkey=ding_xxx_yyy',
  ];
  for (const c of cases) {
    const out = cli.sanitize(c);
    assert.doesNotMatch(out, /bE3xxxx|secret123|ding_xxx_yyy/, `sanitize leak in: ${c} -> ${out}`);
  }
});

test('B20: 业务 fetch 永不返 → exit 7', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b20-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const r = runCli({
    args: ['get-template', '--template-name', '日报', '--userid', 'u9'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u9',
      HOME: tmpHome,
      DINGTALK_TEST_HARD_TIMEOUT_MS: '300',
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([{ delay: 5000 }]),
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 7);
    assert.match(r.stderr, /hard timeout/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B28: gettoken 永不返(cache miss) → exit 7 而非 2', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b28-'));
  const r = runCli({
    args: ['get-template', '--template-name', '日报', '--userid', 'u9'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u9',
      HOME: tmpHome,
      DINGTALK_TEST_HARD_TIMEOUT_MS: '300',
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([{ delay: 5000 }]),
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 7);
    assert.match(r.stderr, /hard timeout/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B21: save-content happy path', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b21-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const r = runCli({
    args: ['save-content', '--template-id', 'tpl1', '--contents', '[{"key":"a","sort":"0","type":"1","content_type":"markdown","content":"x"}]', '--userid', 'u'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u', HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([{ body: { errcode: 0, result: 'saved_xyz' } }]),
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.errcode, 0);
    assert.equal(j.saved_id, 'saved_xyz');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B27: result 形态归一化 (string vs object)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b27-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const args = ['create-report', '--template-id', 'tpl1', '--contents', '[{"key":"a","sort":"0","type":"1","content_type":"markdown","content":"x"}]', '--userid', 'u'];

  // case 1: result 是 string
  const r1 = runCli({
    args, env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u', HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([{ body: { errcode: 0, result: 'id_str' } }]),
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  // case 2: result 是 {report_id}
  const r2 = runCli({
    args, env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u', HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([{ body: { errcode: 0, result: { report_id: 'id_obj' } } }]),
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(JSON.parse(r1.stdout).report_id, 'id_str');
    assert.equal(JSON.parse(r2.stdout).report_id, 'id_obj');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r1.cleanup(); r2.cleanup();
  }
});

test('B15: get-template 完整 result 透传', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b15-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const result = {
    id: 'tid_abc',
    fields: [{ field_name: 'a', sort: 0, type: 1 }, { field_name: 'b', sort: 1, type: 1 }, { field_name: 'c', sort: 2, type: 1 }],
    default_received_convs: [{ conversation_id: '$DD_xxx', title: '群A' }],
    default_receivers: [{ userid: 'u1', user_name: '张三' }],
  };
  const r = runCli({
    args: ['get-template', '--template-name', '日报', '--userid', 'u9'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'u9', HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([{ body: { errcode: 0, result } }]),
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.result.id, 'tid_abc');
    assert.equal(j.result.fields.length, 3);
    assert.equal(j.result.default_received_convs[0].conversation_id, '$DD_xxx');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B16: list-templates 单页', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b16-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const r = runCli({
    args: ['list-templates', '--size', '50'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([{ body: { errcode: 0, result: { template_list: [{ name: 'A', report_code: 'r1' }] } } }]),
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.result.template_list.length, 1);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B17: --all 翻页合并', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b17-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const counter = path.join(tmpHome, 'fc.json');
  const r = runCli({
    args: ['list-templates', '--all', '--size', '100'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([
        { body: { errcode: 0, result: { template_list: [{ name: 'A' }], next_cursor: 100 } } },
        { body: { errcode: 0, result: { template_list: [{ name: 'B' }], next_cursor: null } } },
      ]),
      DINGTALK_TEST_FETCH_COUNTER: counter,
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.result.template_list.length, 2);
    assert.equal(j.result.pages_fetched, 2);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B18: --size 500 截断为 100 + WARN', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b18-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const fetchMockPath = path.join(tmpHome, 'fetch-mock-b18.js');
  fs.writeFileSync(fetchMockPath, `
    'use strict';
    const fs = require('node:fs');
    module.exports = async function (url, opts) {
      if (url.includes('listbyuserid')) {
        const body = JSON.parse(opts.body);
        fs.writeFileSync(process.env.DINGTALK_TEST_BODY_DUMP, JSON.stringify(body));
      }
      return { status: 200, ok: true, json: async () => ({ errcode: 0, result: { template_list: [], next_cursor: null } }), text: async () => '{}' };
    };
  `);
  const dump = path.join(tmpHome, 'body.json');
  const r = runCli({
    args: ['list-templates', '--size', '500'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', HOME: tmpHome,
      DINGTALK_TEST_BODY_DUMP: dump,
    },
    fetchMockPath,
  });
  try {
    assert.equal(r.code, 0);
    assert.match(r.stderr, /WARN.*size/);
    const sent = JSON.parse(fs.readFileSync(dump, 'utf-8'));
    assert.equal(sent.size, 100);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B25: --all 50 页上限', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b25-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const counter = path.join(tmpHome, 'fc.json');
  const fetchMockPath = path.join(tmpHome, 'fetch-mock-b25.js');
  fs.writeFileSync(fetchMockPath, `
    'use strict';
    const fs = require('node:fs');
    module.exports = async function (url) {
      if (process.env.DINGTALK_TEST_FETCH_COUNTER) {
        const f = process.env.DINGTALK_TEST_FETCH_COUNTER;
        const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : { calls: [] };
        cur.calls.push('listbyuserid');
        fs.writeFileSync(f, JSON.stringify(cur));
      }
      return { status: 200, ok: true, json: async () => ({ errcode: 0, result: { template_list: [{}], next_cursor: 'never_ends' } }), text: async () => '{}' };
    };
  `);
  const r = runCli({
    args: ['list-templates', '--all'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', HOME: tmpHome,
      DINGTALK_TEST_FETCH_COUNTER: counter,
    },
    fetchMockPath,
  });
  try {
    assert.equal(r.code, 5);
    assert.match(r.stderr, /pagination cap.*50/);
    const calls = readCounter(counter).calls;
    assert.equal(calls.length, 50);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});

test('B19: get-user 不脱敏 mobile/email', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tmpHome = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dingtalk-test-b19-'));
  const cacheDir = path.join(tmpHome, '.cache', 'dingtalk');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, 'token.json'), JSON.stringify({
    access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  const r = runCli({
    args: ['get-user', '--userid', 'u1', '--language', 'en_US'],
    env: {
      DINGTALK_APPKEY: 'k', DINGTALK_APPSECRET: 's', DINGTALK_USERID: 'admin', HOME: tmpHome,
      DINGTALK_TEST_FETCH_PLAN: JSON.stringify([{ body: { errcode: 0, result: { userid: 'u1', mobile: '13800001234', email: 'foo@bar.com', title: 'eng' } } }]),
    },
    fetchMockPath: path.join(__dirname, 'fixtures', 'fetch-counter.js'),
  });
  try {
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.result.mobile, '13800001234');
    assert.equal(j.result.email, 'foo@bar.com');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    r.cleanup();
  }
});
