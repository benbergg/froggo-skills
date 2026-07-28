'use strict';
// discover.js BDD 测试:打分公式、四类淘汰、零候选 exit 4、state 去重。
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli, FIXTURE, freshTmp } = require('./helpers');

const D = require('../references/scripts/discover.js');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'references', 'channels.json'), 'utf-8'));
const TODAY = '2026-07-27';

function vid(over = {}) {
  return {
    id: 'vid00000001', title: 'How we built an agentic coding system',
    channelTitle: 'AI Engineer', channelId: CFG.channels[0].channelId,
    publishedAt: '2026-07-27T02:00:00Z', duration: 'PT35M12S',
    description: '', liveBroadcastContent: 'none', ...over,
  };
}

test('T1: ISO 8601 时长解析', () => {
  assert.equal(D.parseDurationToSeconds('PT35M12S'), 2112);
  assert.equal(D.parseDurationToSeconds('PT1H2M3S'), 3723);
  assert.equal(D.parseDurationToSeconds('PT45S'), 45);
});

test('T2: 关键词命中提高分数', () => {
  const ch = CFG.channels[0];
  const hit = D.scoreVideo(vid({ title: 'How we built agentic evals' }), ch, CFG, TODAY);
  const miss = D.scoreVideo(vid({ title: 'Company holiday party recap' }), ch, CFG, TODAY);
  assert.ok(hit > miss, `命中(${hit}) 应高于未命中(${miss})`);
});

test('T3: 频道权重线性影响分数', () => {
  const high = CFG.channels.find((c) => c.weight === 1.0);
  const low = CFG.channels.find((c) => c.weight === 0.6);
  const a = D.scoreVideo(vid({ channelId: high.channelId }), high, CFG, TODAY);
  const b = D.scoreVideo(vid({ channelId: low.channelId }), low, CFG, TODAY);
  assert.ok(Math.abs(a / b - high.weight / low.weight) < 0.001);
});

test('T4: 时长过短降权', () => {
  const ch = CFG.channels[0];
  const short = D.scoreVideo(vid({ duration: 'PT3M' }), ch, CFG, TODAY);
  const ideal = D.scoreVideo(vid({ duration: 'PT35M' }), ch, CFG, TODAY);
  assert.ok(short < ideal * 0.5, `过短(${short}) 应显著低于理想(${ideal})`);
});

test('T5: 发布越久分数越低', () => {
  const ch = CFG.channels[0];
  const fresh = D.scoreVideo(vid({ publishedAt: '2026-07-27T02:00:00Z' }), ch, CFG, TODAY);
  const old = D.scoreVideo(vid({ publishedAt: '2026-07-20T02:00:00Z' }), ch, CFG, TODAY);
  assert.ok(fresh > old);
});

test('T6: 淘汰 — Shorts', () => {
  assert.equal(D.rejectReason(vid({ duration: 'PT45S' }), CFG, new Set()), 'shorts');
  assert.equal(D.rejectReason(vid({ title: 'Quick tip #shorts' }), CFG, new Set()), 'shorts');
});

test('T7: 淘汰 — 超长(>100min)', () => {
  assert.equal(D.rejectReason(vid({ duration: 'PT2H30M' }), CFG, new Set()), 'too_long');
});

test('T8: 淘汰 — 已处理', () => {
  assert.equal(D.rejectReason(vid({ id: 'seen1234567' }), CFG, new Set(['seen1234567'])), 'processed');
});

test('T9: 淘汰 — 直播进行中', () => {
  assert.equal(D.rejectReason(vid({ liveBroadcastContent: 'live' }), CFG, new Set()), 'live');
});

test('T10: 合格视频不被淘汰', () => {
  assert.equal(D.rejectReason(vid(), CFG, new Set()), null);
});

test('T11: CLI 从 fixture 产出 candidates.json,按分数降序', () => {
  const out = freshTmp();
  const r = runCli({ script: 'discover.js', args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json')] });
  try {
    assert.equal(r.code, 0, `expected 0, got ${r.code}: ${r.stderr}`);
    const c = JSON.parse(fs.readFileSync(path.join(out, 'candidates.json'), 'utf-8'));
    assert.ok(c.candidates.length >= 2);
    for (let i = 1; i < c.candidates.length; i++) {
      assert.ok(c.candidates[i - 1].score >= c.candidates[i].score, '未按分数降序');
    }
    assert.ok(c.candidates.every((x) => x.url.startsWith('https://www.youtube.com/watch?v=')));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T12: 全部被淘汰 → exit 4', () => {
  const out = freshTmp();
  const state = path.join(out, 'processed.json');
  const raw = JSON.parse(fs.readFileSync(FIXTURE('videos-api-ok.json'), 'utf-8'));
  fs.writeFileSync(state, JSON.stringify({ processed: raw.items.map((i) => i.id) }));
  const r = runCli({ script: 'discover.js', args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--state', state] });
  try {
    assert.equal(r.code, 4, `expected 4, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /no candidates/i);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

// ---- FR5(最终修复轮):loadProcessed 原实现 catch { return new Set(); } 静默吞掉损坏的
// processed.json —— 去重状态无声归零,后果是重新选中已经发过的视频、重复生成并广播,
// 运维侧没有任何信号。这里要求:损坏时仍返回空集合(不中止流程),但必须先往 stderr
// 打一条 WARN,点明"去重状态本次失效"。

test('T13: --state 指向损坏的 processed.json → WARN 到 stderr,去重状态本次失效但不中止流程(FR5)', () => {
  const out = freshTmp();
  const state = path.join(out, 'processed.json');
  fs.writeFileSync(state, 'not valid json {{{');
  const r = runCli({
    script: 'discover.js',
    args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--state', state],
  });
  try {
    assert.equal(r.code, 0, `expected 0(损坏的去重状态不应中止流程), got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /WARN/);
    assert.match(r.stderr, /去重状态本次失效/, 'WARN 文案应明确点出去重状态失效,而不是静默无信号');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

// ---- 方案 B(2026-07-28):归档目录作为去重的第二事实源。
// 实证问题:7-28 归档目录里有 2 篇,processed.json 只记了 1 条 —— 归档成功与 state 写入
// 不是原子的,漏记的那一篇次日会被重新选中、重跑整条流水线。归档目录里躺着的 HTML 是
// 比 processed.json 更可靠的"这个视频已经出过"证据,扫它天然幂等。

function writeArchive(root, relPath, videoId) {
  const p = path.join(root, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `<!doctype html><html><body>
<a href="https://www.youtube.com/watch?v=${videoId}&t=356s">[5:56]</a>
<iframe src="https://www.youtube.com/embed/${videoId}"></iframe>
</body></html>`);
  return p;
}

test('T14: 归档 HTML 里的 video_id 被淘汰,原因 archived(与 processed 区分开)', () => {
  const out = freshTmp();
  const archive = freshTmp();
  writeArchive(archive, '2026/2026-07-28-some-talk.html', 'aaaaaaaaaaa');
  const r = runCli({
    script: 'discover.js',
    args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--archive', archive],
  });
  try {
    assert.equal(r.code, 0, `expected 0, got ${r.code}: ${r.stderr}`);
    const c = JSON.parse(fs.readFileSync(path.join(out, 'candidates.json'), 'utf-8'));
    assert.equal(c.rejected['aaaaaaaaaaa'], 'archived', '归档里的视频应被淘汰且原因可区分');
    assert.ok(!c.candidates.some((x) => x.id === 'aaaaaaaaaaa'), '归档过的视频不该再进候选');
    assert.ok(c.candidates.some((x) => x.id === 'bbbbbbbbbbb'), '未归档的视频应保留');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(archive, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T15: --archive 目录不存在 → 静默跳过,不 WARN 不中止(首次运行的正常形态)', () => {
  const out = freshTmp();
  const missing = path.join(freshTmp(), 'never-created');
  const r = runCli({
    script: 'discover.js',
    args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--archive', missing],
  });
  try {
    assert.equal(r.code, 0, `expected 0, got ${r.code}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /WARN/, '归档目录尚不存在是首次运行的正常状态,不该报警');
    const c = JSON.parse(fs.readFileSync(path.join(out, 'candidates.json'), 'utf-8'));
    assert.ok(c.candidates.length >= 2);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T16: processed.json 与归档取并集,两个来源各自的淘汰原因都正确', () => {
  const out = freshTmp();
  const archive = freshTmp();
  const state = path.join(out, 'processed.json');
  fs.writeFileSync(state, JSON.stringify({ processed: ['bbbbbbbbbbb'] }));
  writeArchive(archive, '2026/x.html', 'aaaaaaaaaaa');
  const r = runCli({
    script: 'discover.js',
    args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--state', state, '--archive', archive],
  });
  try {
    // fixture 第三条是 shorts,本就被淘汰 → 两来源各吃掉一条后无候选,exit 4 是正确结果。
    // 本例要验的是"并集生效且两种来源可区分",不是候选数量(T14 已覆盖未归档的保留)。
    assert.equal(r.code, 4, `expected 4, got ${r.code}: ${r.stderr}`);
    const c = JSON.parse(fs.readFileSync(path.join(out, 'candidates.json'), 'utf-8'));
    assert.equal(c.rejected['aaaaaaaaaaa'], 'archived');
    assert.equal(c.rejected['bbbbbbbbbbb'], 'processed');
    assert.equal(c.candidates.length, 0);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(archive, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T17: 归档目录里的非 HTML 文件与无视频链接的 HTML 被忽略,不误伤候选', () => {
  const out = freshTmp();
  const archive = freshTmp();
  fs.writeFileSync(path.join(archive, 'index.html'), '<a href="2026/foo.html">foo</a>');
  fs.writeFileSync(path.join(archive, 'notes.md'), 'https://www.youtube.com/embed/aaaaaaaaaaa');
  const r = runCli({
    script: 'discover.js',
    args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--archive', archive],
  });
  try {
    assert.equal(r.code, 0, `expected 0, got ${r.code}: ${r.stderr}`);
    const c = JSON.parse(fs.readFileSync(path.join(out, 'candidates.json'), 'utf-8'));
    assert.ok(c.candidates.some((x) => x.id === 'aaaaaaaaaaa'),
      '.md 里的链接不算归档凭据(归档产物是 HTML),index.html 无视频链接也不该匹配');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(archive, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T18: --archive 指向普通文件 → WARN 点明归档去重失效,但不中止流程', () => {
  const out = freshTmp();
  const notDir = path.join(freshTmp(), 'a-file.html');
  fs.writeFileSync(notDir, 'x');
  const r = runCli({
    script: 'discover.js',
    args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--archive', notDir],
  });
  try {
    assert.equal(r.code, 0, `expected 0(归档扫描失败不应中止今天的发现), got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /WARN/);
    assert.match(r.stderr, /归档去重本次失效/, 'WARN 文案应明确点出归档去重失效,而不是静默无信号');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T19: 归档扫描深入年份子目录,且 stderr 报出扫描到的条数(运维可见)', () => {
  const out = freshTmp();
  const archive = freshTmp();
  writeArchive(archive, '2025/old.html', 'aaaaaaaaaaa');
  writeArchive(archive, '2026/new.html', 'bbbbbbbbbbb');
  const r = runCli({
    script: 'discover.js',
    args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--archive', archive],
  });
  try {
    assert.equal(r.code, 4, `两条合格视频都在归档里 → 无候选, got ${r.code}: ${r.stderr}`);
    const c = JSON.parse(fs.readFileSync(path.join(out, 'candidates.json'), 'utf-8'));
    assert.equal(c.rejected['aaaaaaaaaaa'], 'archived', '2025/ 子目录未被扫到');
    assert.equal(c.rejected['bbbbbbbbbbb'], 'archived', '2026/ 子目录未被扫到');
    assert.match(r.stderr, /archived=2/, 'stderr 应报出归档扫描到的 id 条数');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(archive, { recursive: true, force: true });
    r.cleanup();
  }
});

// ---- 方案 E(2026-07-28):频道多样性。
// 实证问题:7-28 产出的两篇都来自 AI Engineer 频道,打分公式里没有任何一项在管
// "最近是不是老出同一家"。做成**降权**而不是排除 —— 某天确实只有那个频道有好内容时,
// 仍然该选它,只是要先被别的频道公平地比一比。
// 历史来自 processed.json 的 history 字段(Step 5 写入);旧格式没有这个字段,
// 必须照常工作 —— 去重是主线功能,不能被多样性这个次要特性拖挂。

function histState(dir, entries) {
  const p = path.join(dir, 'processed.json');
  fs.writeFileSync(p, JSON.stringify({ processed: [], history: entries }));
  return p;
}

test('T20: 近 7 天出过的频道被降权,但仍是正分(降权不是排除)', () => {
  const ch = CFG.channels[0];
  const base = D.scoreVideo(vid(), ch, CFG, TODAY, []);
  const penal = D.scoreVideo(vid(), ch, CFG, TODAY,
    [{ id: 'x', channel: ch.handle, date: '2026-07-26' }]);
  assert.ok(penal < base, `出过的频道应降权: ${penal} 应 < ${base}`);
  assert.ok(penal > 0, '降权不该把分数打到 0 —— 那等于排除');
});

test('T21: 近期出现次数越多,降权越狠', () => {
  const ch = CFG.channels[0];
  const once = D.scoreVideo(vid(), ch, CFG, TODAY, [{ id: 'a', channel: ch.handle, date: '2026-07-26' }]);
  const twice = D.scoreVideo(vid(), ch, CFG, TODAY, [
    { id: 'a', channel: ch.handle, date: '2026-07-26' },
    { id: 'b', channel: ch.handle, date: '2026-07-25' },
  ]);
  assert.ok(twice < once, `两次应比一次降得更狠: ${twice} 应 < ${once}`);
});

test('T22: 超出窗口的历史不再降权(窗口是滑动的,不是永久黑名单)', () => {
  const ch = CFG.channels[0];
  const base = D.scoreVideo(vid(), ch, CFG, TODAY, []);
  const old = D.scoreVideo(vid(), ch, CFG, TODAY,
    [{ id: 'x', channel: ch.handle, date: '2026-06-01' }]);
  assert.equal(old, base, '两个月前出过的频道不该还在被压');
});

test('T23: 别的频道出过不影响本频道(降权按频道计,不是全局)', () => {
  const a = CFG.channels[0];
  const b = CFG.channels[1];
  const base = D.scoreVideo(vid(), a, CFG, TODAY, []);
  const other = D.scoreVideo(vid(), a, CFG, TODAY, [{ id: 'x', channel: b.handle, date: '2026-07-26' }]);
  assert.equal(other, base);
});

test('T24: 旧格式 state(无 history 字段)照常工作,不降权也不报错(向后兼容)', () => {
  const out = freshTmp();
  const state = path.join(out, 'processed.json');
  fs.writeFileSync(state, JSON.stringify({ processed: ['zzzzzzzzzzz'] }));
  const r = runCli({
    script: 'discover.js',
    args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--state', state, '--today', TODAY],
  });
  try {
    assert.equal(r.code, 0, `旧格式 state 不该让流程挂掉: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /WARN/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T25: CLI 端到端 — history 里有该频道时,候选分数低于无 history 时', () => {
  const run = (entries) => {
    const out = freshTmp();
    const args = ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--today', TODAY];
    if (entries) args.push('--state', histState(out, entries));
    const r = runCli({ script: 'discover.js', args });
    const c = JSON.parse(fs.readFileSync(path.join(out, 'candidates.json'), 'utf-8'));
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
    return { code: r.code, top: c.candidates[0] };
  };
  const plain = run(null);
  const penalized = run([{ id: 'zzz', channel: '@aiDotEngineer', date: '2026-07-26' }]);
  assert.equal(plain.code, 0);
  assert.equal(penalized.code, 0);
  assert.ok(penalized.top.score < plain.top.score,
    `降权应体现在 candidates.json 的 score 上: ${penalized.top.score} 应 < ${plain.top.score}`);
});
