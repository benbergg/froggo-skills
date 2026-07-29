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

// ---- 2026-07-29 字幕层塌方修复(A1-A4) ---------------------------------
//
// 当天实证:87 个候选里前 3 名字幕全取不到,流水线一路静默滑到第 4 名的
// 2 分 12 秒产品广告片并把它做成了教程。VM 上手工复现 yt-dlp 拿到三条决定性
// stderr —— 但生产日志里一条都没有,因为 tryYtDlp 把 stderr 整个丢了,
// 只留下 `no json3 produced (exit 0)`。下面的夹具就是那三条原文。

const FAKE_YTDLP = FIXTURE('fake-yt-dlp.js');

// 2026-07-29 VM 实测 stderr 原文(jyuyY86GJnA):bot 检测 + PO token 缺失 + 无字幕 同时出现
const STDERR_BOT_AND_NOSUB = [
  '[youtube] jyuyY86GJnA: Downloading tv downgraded player API JSON',
  'WARNING: [youtube] jyuyY86GJnA: n challenge solving failed: Some formats may be missing.',
  'WARNING: [youtube] Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
  'WARNING: [youtube] jyuyY86GJnA: There are missing subtitles languages because a PO token was not provided. Automatic captions for 1 languages are missing.',
  '[info] There are no subtitles for the requested languages',
].join('\n');

// 2026-07-29 VM 实测 stderr 原文(vJYXvblW4_g):cookie 已被轮换失效
const STDERR_COOKIE_ROTATED = [
  'WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled by default;',
  'WARNING: [youtube] The provided YouTube account cookies are no longer valid. They have likely been rotated in the browser as a security measure.',
  'WARNING: [youtube] Sign in to confirm you’re not a bot.',
  '[info] There are no subtitles for the requested languages',
].join('\n');

// 干净的"这个视频确实没有英文字幕":无任何环境故障信号
const STDERR_PURE_NO_SUB = [
  '[youtube] abcdefghijk: Downloading webpage',
  '[youtube] abcdefghijk: Downloading player API JSON',
  '[info] There are no subtitles for the requested languages',
].join('\n');

test('T15: bot 检测判为环境故障(unicode 撇号 U+2019,不是 ASCII 单引号)', () => {
  assert.equal(F.classifyYtDlpFailure(STDERR_BOT_AND_NOSUB), 'environment');
  // ASCII 撇号变体也要认 —— yt-dlp 文案随版本会换
  assert.equal(F.classifyYtDlpFailure("WARNING: Sign in to confirm you're not a bot."), 'environment');
});

test('T16: cookie 被轮换失效判为环境故障', () => {
  assert.equal(F.classifyYtDlpFailure(STDERR_COOKIE_ROTATED), 'environment');
});

test('T17: PO token 缺失判为环境故障(自动字幕整类取不到,不是这个视频的问题)', () => {
  assert.equal(F.classifyYtDlpFailure(
    'WARNING: [youtube] xyz: There are missing subtitles languages because a PO token was not provided.'
  ), 'environment');
});

test('T18: 干净的无字幕判为内容性失败', () => {
  assert.equal(F.classifyYtDlpFailure(STDERR_PURE_NO_SUB), 'no_subtitles');
});

test('T19: 环境信号与无字幕信号同时出现时判环境故障(这是当天真实形态,判错就会继续滑落)', () => {
  // 两条真实 stderr 结尾都带 "There are no subtitles for the requested languages"。
  // 若按"先看到无字幕就算内容性失败"处理,今天这场事故会原样重演。
  assert.equal(F.classifyYtDlpFailure(STDERR_BOT_AND_NOSUB), 'environment');
  assert.equal(F.classifyYtDlpFailure(STDERR_COOKIE_ROTATED), 'environment');
});

test('T20: 转录体量不足 —— 2 分钟广告片(2052 字符/132 秒)被拦下', () => {
  // 当天被做成教程的 WeP9VUf1OoE 的真实体量。密度(933 字符/分)其实正常,
  // 拦它靠的是绝对下限:低于这个量根本写不出七段教程。
  assert.equal(F.isTranscriptSufficient('x'.repeat(2052), 132), false);
});

test('T21: 真实长片放行(实测 523 与 1012 字符/分两端)', () => {
  assert.equal(F.isTranscriptSufficient('x'.repeat(11329), 1299), true, '22 分钟演讲,523 字符/分');
  assert.equal(F.isTranscriptSufficient('x'.repeat(41711), 2474), true, '41 分钟演讲,1012 字符/分');
});

test('T22: 长视频只取到残缺字幕被拦下(55 分钟只拿到 2500 字符)', () => {
  assert.equal(F.isTranscriptSufficient('x'.repeat(2500), 3300), false);
});

test('T23: yt-dlp 不得就地改写 cookie 源文件(根因层 3:文件从 16 字段被啃到 13 字段)', () => {
  const dir = freshTmp();
  const cookiePath = path.join(dir, 'cookies.txt');
  const original = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t2000000000\t__Secure-3PAPISID\tvalue1',
    '.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSAPISID\tvalue2',
  ].join('\n');
  fs.writeFileSync(cookiePath, original);
  const prevBin = process.env.YT_DLP_PATH;
  const prevTamper = process.env.FAKE_YTDLP_TAMPER;
  process.env.YT_DLP_PATH = FAKE_YTDLP;
  process.env.FAKE_YTDLP_TAMPER = '1';
  process.env.FAKE_YTDLP_JSON3 = '1';
  try {
    F.tryYtDlp('someVideoId', cookiePath);
    assert.equal(fs.readFileSync(cookiePath, 'utf-8'), original, 'cookie 源文件必须一字不变');
  } finally {
    if (prevBin === undefined) delete process.env.YT_DLP_PATH; else process.env.YT_DLP_PATH = prevBin;
    if (prevTamper === undefined) delete process.env.FAKE_YTDLP_TAMPER; else process.env.FAKE_YTDLP_TAMPER = prevTamper;
    delete process.env.FAKE_YTDLP_JSON3;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T24: yt-dlp 失败时错误信息必须带上它的 stderr(否则根因全部丢失)', () => {
  const dir = freshTmp();
  const cookiePath = path.join(dir, 'cookies.txt');
  fs.writeFileSync(cookiePath, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tv\n');
  const prevBin = process.env.YT_DLP_PATH;
  process.env.YT_DLP_PATH = FAKE_YTDLP;
  process.env.FAKE_YTDLP_STDERR = STDERR_BOT_AND_NOSUB;
  try {
    assert.throws(
      () => F.tryYtDlp('someVideoId', cookiePath),
      /not a bot|PO token/,
      '错误信息里应能看到 yt-dlp 的真实抱怨,而不只是 no json3 produced'
    );
  } finally {
    if (prevBin === undefined) delete process.env.YT_DLP_PATH; else process.env.YT_DLP_PATH = prevBin;
    delete process.env.FAKE_YTDLP_STDERR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// CLI 级:只跑 yt-dlp 这一级(--tiers),避免测试真的去打 InnerTube 端点
function cliWithFakeYtDlp({ candidates, plan, extraEnv = {} }) {
  const dir = freshTmp();
  const candPath = path.join(dir, 'candidates.json');
  fs.writeFileSync(candPath, JSON.stringify({ candidates }));
  const cookiePath = path.join(dir, 'cookies.txt');
  fs.writeFileSync(cookiePath, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSAPISID\tv\n');
  const out = path.join(dir, 'out');
  const r = runCli({
    script: 'fetch-transcript.js',
    args: ['--candidates', candPath, '--out', out, '--cookies', cookiePath, '--tiers', 'yt-dlp'],
    env: {
      YT_DLP_PATH: FAKE_YTDLP,
      FAKE_YTDLP_PLAN: JSON.stringify(plan),
      ...extraEnv,
    },
  });
  return { ...r, dir, out, cleanupAll: () => { fs.rmSync(dir, { recursive: true, force: true }); r.cleanup(); } };
}

const CAND = (id, durationSec, title) => ({
  id, title, channelTitle: 'Fake', channelHandle: '@fake', topic: 'agentic',
  publishedAt: '2026-07-29T00:00:00Z', durationSec, score: 1,
  url: `https://www.youtube.com/watch?v=${id}`,
});

test('T25: 环境故障 → exit 7 并停止,不再往下滑到别的候选', () => {
  const r = cliWithFakeYtDlp({
    candidates: [CAND('aaaaaaaaaaa', 1800, '高分真演讲'), CAND('bbbbbbbbbbb', 132, '两分钟广告片')],
    plan: {
      aaaaaaaaaaa: { mode: 'fail', stderr: STDERR_BOT_AND_NOSUB },
      bbbbbbbbbbb: { mode: 'ok', cues: 60 },
    },
  });
  try {
    assert.equal(r.code, 7, `期望 exit 7(环境故障),实际 ${r.code}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /bbbbbbbbbbb/, '环境故障后不得继续尝试后续候选');
    assert.ok(!fs.existsSync(path.join(r.out, 'selected.json')), '不得产出 selected.json');
  } finally {
    r.cleanupAll();
  }
});

test('T26: 内容性失败(该视频确实没字幕)→ 照常滑到下一个候选', () => {
  const r = cliWithFakeYtDlp({
    candidates: [CAND('aaaaaaaaaaa', 1800, '没有字幕的演讲'), CAND('bbbbbbbbbbb', 1800, '有字幕的演讲')],
    plan: {
      aaaaaaaaaaa: { mode: 'fail', stderr: STDERR_PURE_NO_SUB },
      bbbbbbbbbbb: { mode: 'ok', cues: 120 },
    },
  });
  try {
    assert.equal(r.code, 0, `期望 exit 0,实际 ${r.code}: ${r.stderr}`);
    const sel = JSON.parse(fs.readFileSync(path.join(r.out, 'selected.json'), 'utf-8'));
    assert.equal(sel.id, 'bbbbbbbbbbb');
  } finally {
    r.cleanupAll();
  }
});

test('T27: 取到但体量不足 → 视为该候选失败,继续下一个,不把残片做成教程', () => {
  const r = cliWithFakeYtDlp({
    candidates: [CAND('aaaaaaaaaaa', 3300, '55 分钟长片但只取到残缺字幕'), CAND('bbbbbbbbbbb', 1800, '完整字幕')],
    plan: {
      aaaaaaaaaaa: { mode: 'thin', cues: 20 },   // 约 2000 字符,55 分钟片远不够
      bbbbbbbbbbb: { mode: 'ok', cues: 120 },    // 约 12000 字符,30 分钟片够
    },
  });
  try {
    assert.equal(r.code, 0, `期望 exit 0,实际 ${r.code}: ${r.stderr}`);
    const sel = JSON.parse(fs.readFileSync(path.join(r.out, 'selected.json'), 'utf-8'));
    assert.equal(sel.id, 'bbbbbbbbbbb', '残缺字幕的候选不得被选中');
    assert.match(r.stderr, /体量不足|too short|insufficient/i, '应留下可读的跳过理由');
  } finally {
    r.cleanupAll();
  }
});
