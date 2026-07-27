'use strict';
// fetch-transcript.js BDD 测试:XML 双格式解析(保留时间戳)、段落合并、cookie 解析、时间戳格式化。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURE, runCli, freshTmp } = require('./helpers');

const F = require('../references/scripts/fetch-transcript.js');

test('T1: srv3 格式解析并保留时间戳', () => {
  const cues = F.parseTimedTextXml(fs.readFileSync(FIXTURE('timedtext-srv3.xml'), 'utf-8'));
  assert.ok(cues.length >= 3, `期望 ≥3 条,实际 ${cues.length}`);
  assert.equal(typeof cues[0].tMs, 'number');
  assert.ok(cues[0].text.length > 0);
  for (let i = 1; i < cues.length; i++) {
    assert.ok(cues[i].tMs >= cues[i - 1].tMs, '时间戳应单调不减');
  }
});

test('T2: classic 格式解析并保留时间戳', () => {
  const cues = F.parseTimedTextXml(fs.readFileSync(FIXTURE('timedtext-classic.xml'), 'utf-8'));
  assert.ok(cues.length >= 2);
  assert.equal(cues[0].tMs, 1500, 'start="1.5" 应转成 1500ms');
});

test('T3: HTML 实体解码', () => {
  const cues = F.parseTimedTextXml('<transcript><text start="0" dur="1">it&amp;#39;s &amp;quot;fine&amp;quot;</text></transcript>');
  assert.match(cues[0].text, /it's "fine"/);
});

test('T4: 段落合并到 30-60 秒窗口', () => {
  const cues = [];
  for (let i = 0; i < 120; i++) cues.push({ tMs: i * 2000, text: `word${i}` });  // 每 2 秒一条,共 240 秒
  const segs = F.mergeSegments(cues, { minSec: 30, maxSec: 60 });
  assert.ok(segs.length >= 4 && segs.length <= 9, `期望 4-9 段,实际 ${segs.length}`);
  for (const s of segs) {
    assert.match(s.startLabel, /^\d{1,2}:\d{2}$/);
    assert.ok(s.text.length > 0);
  }
  assert.equal(segs[0].start, 0);
});

test('T5: 合并不丢词', () => {
  const cues = [{ tMs: 0, text: 'alpha' }, { tMs: 1000, text: 'beta' }, { tMs: 2000, text: 'gamma' }];
  const segs = F.mergeSegments(cues, { minSec: 30, maxSec: 60 });
  assert.equal(segs.map((s) => s.text).join(' '), 'alpha beta gamma');
});

test('T6: 时间戳格式化', () => {
  assert.equal(F.formatTimestamp(0), '0:00');
  assert.equal(F.formatTimestamp(75), '1:15');
  assert.equal(F.formatTimestamp(3725), '62:05');
});

test('T7: Netscape cookie 文件解析', () => {
  const raw = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc123',
    '.youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-3PAPISID\txyz789',
  ].join('\n');
  const s = F.parseCookieString(raw);
  assert.match(s, /SID=abc123/);
  assert.match(s, /__Secure-3PAPISID=xyz789/);
});

test('T8: 空/注释-only cookie 文件 → null', () => {
  assert.equal(F.parseCookieString('# only a comment\n'), null);
});

test('T9: resolveYtDlpBin 优先取 YT_DLP_PATH env(fix round 1 F3)', () => {
  const prev = process.env.YT_DLP_PATH;
  process.env.YT_DLP_PATH = '/custom/path/yt-dlp';
  try {
    assert.equal(F.resolveYtDlpBin(), '/custom/path/yt-dlp');
  } finally {
    if (prev === undefined) delete process.env.YT_DLP_PATH; else process.env.YT_DLP_PATH = prev;
  }
});

test('T10: resolveYtDlpBin 无 env 时按候选路径探测,全不存在才回落 "yt-dlp"', () => {
  const prev = process.env.YT_DLP_PATH;
  delete process.env.YT_DLP_PATH;
  try {
    // 与实现内的候选列表保持一致:第一个真实存在的路径胜出,否则回落 'yt-dlp'。
    // 不假设本机是否装了全局 yt-dlp(mac 测试机可能有 /usr/local/bin/yt-dlp,
    // VM 上没有但有 venv 路径)——用同样的探测逻辑独立计算期望值,避免环境耦合。
    const candidates = [
      '/home/ubuntu/.local/yt-dlp-venv/bin/yt-dlp',
      path.join(os.homedir(), '.local', 'yt-dlp-venv', 'bin', 'yt-dlp'),
      path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),
      '/usr/local/bin/yt-dlp',
      '/opt/homebrew/bin/yt-dlp',
    ];
    const expected = candidates.find((c) => fs.existsSync(c)) || 'yt-dlp';
    assert.equal(F.resolveYtDlpBin(), expected);
  } finally {
    if (prev !== undefined) process.env.YT_DLP_PATH = prev;
  }
});

test('T11: 空壳 cookie 文件(缺 SAPISID/__Secure-3PAPISID)级 2 直接拒绝,不发请求(fix round 2 F2 防御)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-cookie-test-'));
  const shellCookiePath = path.join(dir, 'shell-cookies.txt');
  // 模拟 VM 上曾出现的空壳 cookie:有 cookie 行,但都不是 SAPISID 相关字段
  fs.writeFileSync(shellCookiePath, [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-3PSID\tsomevalue',
    '.youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-1PSIDTS\tanothervalue',
  ].join('\n'));
  try {
    await assert.rejects(
      () => F.tryWebWithCookies('dummyVideoId', shellCookiePath),
      /cookie 文件疑似无效/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T12: --candidates 指向不存在的文件 → exit 1(fix round 3 F4:不能落到 exit 6)', () => {
  const out = freshTmp();
  const r = runCli({
    script: 'fetch-transcript.js',
    args: ['--candidates', '/no/such/path/candidates.json', '--out', out],
  });
  try {
    assert.equal(r.code, 1, `expected 1, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /Failed to read\/parse --candidates/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T13: --candidates 指向损坏 JSON → exit 1(fix round 3 F4:不能落到 exit 6)', () => {
  const dir = freshTmp();
  const badPath = path.join(dir, 'bad-candidates.json');
  fs.writeFileSync(badPath, 'not json');
  const out = freshTmp();
  const r = runCli({
    script: 'fetch-transcript.js',
    args: ['--candidates', badPath, '--out', out],
  });
  try {
    assert.equal(r.code, 1, `expected 1, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /Failed to read\/parse --candidates/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

// ---- FR2(最终修复轮):discover.js 零候选时仍无条件写出 candidates.json(candidates: []),
// 若这份文件被直接传给 fetch-transcript.js(违反 SKILL.md Step 1 exit 4 分支的散文约束时),
// 旧实现会走到 for 循环空转、直落 exit 6,触发 SKILL.md:110 那条"所有候选取字幕均失败,
// 请人工核查候选与 cookie/yt-dlp 状态"的告警 —— 内容是错的,会把运维引向无关排查方向。
// 本轮把这个场景在 fetch-transcript.js 入口显式拦截为 exit 1 + 准确文案,不再落到 exit 6。

test('T14: --candidates 的 candidates 数组为空 → exit 1,不落到 exit 6(FR2:零候选应止步于 discover.js exit 4 分支)', () => {
  const dir = freshTmp();
  const candPath = path.join(dir, 'candidates.json');
  fs.writeFileSync(candPath, JSON.stringify({ generated_at: '2026-07-27', candidates: [], rejected: {} }));
  const out = freshTmp();
  const r = runCli({
    script: 'fetch-transcript.js',
    args: ['--candidates', candPath, '--out', out],
  });
  try {
    assert.equal(r.code, 1, `expected 1, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /candidates 为空/);
    assert.match(r.stderr, /discover\.js exit 4/, '文案应点名正确的零候选分支,避免运维误判成字幕层故障');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});
