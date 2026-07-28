'use strict';
// fetch-thumbnail.js BDD 测试:降级链、占位图识别、体积上限、失败不阻断。
//
// 全部用桩 fetch,不打真网:i.ytimg.com 的返回内容会随视频状态变化,
// 拿它做断言等于让测试结果取决于别人服务器今天的心情。
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli, freshTmp } = require('./helpers');

const T = require('../references/scripts/fetch-thumbnail.js');

// 构造一张"看起来像 JPEG"的 buffer:magic + 填充到指定体积
function fakeJpeg(bytes) {
  const buf = Buffer.alloc(bytes, 0x42);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  return buf;
}

// 按 variant 名给出响应的桩;返回 undefined 表示该档 404
function stubFetch(table) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const name = String(url).split('/').pop().replace('.jpg', '');
    calls.push(name);
    const buf = table[name];
    if (!buf) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  return calls;
}

const realFetch = globalThis.fetch;
function restore() { globalThis.fetch = realFetch; }

test('TT1: 首选 maxresdefault,取到就不再试更低画质', async () => {
  const calls = stubFetch({ maxresdefault: fakeJpeg(300 * 1024) });
  const r = await T.fetchThumbnail('abcdefghijk', 400 * 1024);
  restore();
  assert.equal(r.variant, 'maxresdefault');
  assert.equal(calls.length, 1, `取到就该停,实际试了 ${calls.join('/')}`);
  assert.match(r.data_uri, /^data:image\/jpeg;base64,/);
  assert.equal(r.skipped.length, 0);
});

test('TT2: maxresdefault 缺失 → 依次降级到 sddefault', async () => {
  const calls = stubFetch({ sddefault: fakeJpeg(80 * 1024) });
  const r = await T.fetchThumbnail('abcdefghijk', 400 * 1024);
  restore();
  assert.equal(r.variant, 'sddefault');
  assert.deepEqual(calls, ['maxresdefault', 'sddefault']);
  assert.deepEqual(r.skipped, ['maxresdefault']);
});

test('TT3: 判别 — YouTube 对缺失画质返回 200 + 灰色占位图,必须按缺失处理', async () => {
  // 这是真实行为,不是假想:不看体积只看 res.ok 会把 1KB 灰图当封面内嵌进去,
  // 页头变成一块纯灰,而且因为 exit 0 没有任何告警。
  const calls = stubFetch({ maxresdefault: fakeJpeg(1200), sddefault: fakeJpeg(80 * 1024) });
  const r = await T.fetchThumbnail('abcdefghijk', 400 * 1024);
  restore();
  assert.equal(r.variant, 'sddefault', '1.2KB 的占位图必须被识破并降级');
  assert.deepEqual(calls, ['maxresdefault', 'sddefault']);
});

test('TT4: 判别 — 响应不是 JPEG(网关错误页冒充 200)按缺失处理', async () => {
  const html = Buffer.from('<html><body>error page padded'.padEnd(9000, ' '), 'utf-8');
  stubFetch({ maxresdefault: html, sddefault: fakeJpeg(80 * 1024) });
  const r = await T.fetchThumbnail('abcdefghijk', 400 * 1024);
  restore();
  assert.equal(r.variant, 'sddefault', 'JPEG magic 不符必须降级,不能把 HTML 当图内嵌');
});

test('TT5: 判别 — 超过体积上限的画质被跳过(按 base64 编码后体积卡)', async () => {
  // 300KB 原图 base64 后约 400KB,上限设 350KB 时它必须被跳过
  const calls = stubFetch({ maxresdefault: fakeJpeg(300 * 1024), sddefault: fakeJpeg(80 * 1024) });
  const r = await T.fetchThumbnail('abcdefghijk', 350 * 1024);
  restore();
  assert.equal(r.variant, 'sddefault', `上限该按 base64 后体积算,实际选了 ${r.variant}`);
  assert.deepEqual(calls, ['maxresdefault', 'sddefault']);
});

test('TT6: 三档全不可用 → 返回 null(交给调用方退回纯色页头)', async () => {
  const calls = stubFetch({});
  const r = await T.fetchThumbnail('abcdefghijk', 400 * 1024);
  restore();
  assert.equal(r, null);
  assert.deepEqual(calls, T.VARIANTS.map((v) => v.name), '三档都该试过再放弃');
});

test('TT7: fetch 抛异常(超时/DNS)不冒泡,按该档缺失处理', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    if (n++ === 0) throw new Error('ETIMEDOUT');
    return { ok: true, status: 200, arrayBuffer: async () => {
      const b = fakeJpeg(80 * 1024);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    } };
  };
  const r = await T.fetchThumbnail('abcdefghijk', 400 * 1024);
  restore();
  assert.equal(r.variant, 'sddefault', '一档超时不该带走整条降级链');
});

test('TT8: CLI — selected.json 不存在时 WARN + exit 0(封面不是关键路径)', () => {
  const tmp = freshTmp();
  const r = runCli({ script: 'fetch-thumbnail.js', args: [
    '--selected', path.join(tmp, 'nope.json'), '--out', tmp] });
  assert.equal(r.code, 0, `期望 exit 0(不阻断流水线),实际 ${r.code}: ${r.stderr}`);
  assert.match(r.stderr, /WARN/);
  assert.ok(!fs.existsSync(path.join(tmp, 'thumbnail.json')), '失败时不该留半成品文件');
  fs.rmSync(tmp, { recursive: true, force: true });
  r.cleanup();
});

test('TT9: CLI — selected.json 缺 id 字段时 WARN + exit 0', () => {
  const tmp = freshTmp();
  const sel = path.join(tmp, 'selected.json');
  fs.writeFileSync(sel, JSON.stringify({ title: '没有 id' }));
  const r = runCli({ script: 'fetch-thumbnail.js', args: ['--selected', sel, '--out', tmp] });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /缺 id/);
  fs.rmSync(tmp, { recursive: true, force: true });
  r.cleanup();
});

test('TT10: CLI — 缺必填参数 exit 1(与其他脚本一致)', () => {
  const r = runCli({ script: 'fetch-thumbnail.js', args: ['--out', '/tmp'] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--selected is required/);
  r.cleanup();
});

test('TT11: 产出的 thumbnail.json 字段齐全,可直接喂给 build-html.js --thumbnail', async () => {
  stubFetch({ maxresdefault: fakeJpeg(200 * 1024) });
  const r = await T.fetchThumbnail('abcdefghijk', 400 * 1024);
  restore();
  for (const k of ['video_id', 'variant', 'width', 'height', 'mime', 'bytes', 'data_uri']) {
    assert.ok(k in r, `缺字段 ${k}`);
  }
  assert.equal(r.video_id, 'abcdefghijk');
  assert.equal(r.bytes, 200 * 1024);
  // build-html.js 的 renderHero 只认 data_uri 这一个字段,契约不能漂
  const B = require('../references/scripts/build-html.js');
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'references', 'templates', 'tutorial.html'), 'utf-8');
  const doc = B.parseTutorialMd(fs.readFileSync(path.join(__dirname, 'fixtures', 'tutorial-good.md'), 'utf-8'));
  const html = B.renderHtml(doc, { id: 'abcdefghijk', channelTitle: 'x', durationSec: 60, url: 'https://y' }, tpl, r);
  assert.match(html, /class="hero has-img"/, '两个脚本之间的封面契约断了');
});
