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
  // 两个频道必须声明相同 topics —— 主题分组关键词落地后,不同 topic 的频道
  // keywordFactor 也不同,拿真实频道对比测的就不再是"权重线性"这一件事了。
  const high = { handle: '@high', channelId: CFG.channels[0].channelId, weight: 1.0, topics: ['agentic'] };
  const low = { ...high, handle: '@low', weight: 0.6 };
  const a = D.scoreVideo(vid(), high, CFG, TODAY);
  const b = D.scoreVideo(vid(), low, CFG, TODAY);
  assert.ok(Math.abs(a / b - high.weight / low.weight) < 0.001,
    `权重比 ${high.weight / low.weight} 应等于分数比 ${a / b}`);
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

// ── 主题扩展(2026-07-28):主题判定 + 主题降权 ────────────────────────────
// 标题全部取自 2026-07-28 对各频道的实测抓取,不是构造的 —— 主题判定这种
// "看起来显然对"的逻辑,只有拿真实标题跑才知道分组词有没有真的覆盖到。

const CH = (h) => CFG.channels.find((c) => c.handle === h);

test('T26: 主题由内容判定,不是照搬频道标签', () => {
  const saastr = CH('@SaaStr'); // topics: ["saas", "agentic"]
  const agentish = D.topicOf({ title: 'The Agents #011 - From 0 to 20 Agents and Back Again', description: '' }, saastr, CFG);
  assert.equal(agentish, 'agentic', 'SaaStr 讲 agent 的那期内容是 agentic,不该记成 saas');
  const saasish = D.topicOf({ title: 'How to Close Deals and Collect Cash Faster with pricing changes', description: '' }, saastr, CFG);
  assert.equal(saasish, 'saas');
});

test('T27: 主题候选被频道 topics 限死,不会跑出声明范围', () => {
  const lc = CH('@LangChain'); // topics: ["agentic"] 单主题
  const t = D.topicOf({ title: 'Pricing and churn for our B2B revenue team', description: '' }, lc, CFG);
  assert.equal(t, 'agentic', 'LangChain 只声明了 agentic,再像 SaaS 的标题也不能判成 saas');
});

test('T28: 一个关键词都不中时退回频道第一个主题,不返回 null', () => {
  const lenny = CH('@LennysPodcast'); // topics: ["product", "saas", "design"]
  assert.equal(D.topicOf({ title: 'A conversation about nothing in particular', description: '' }, lenny, CFG), 'product');
});

test('T29: 主题分组关键词真的把非 AI 主题拉出了基线', () => {
  const base = CFG.scoring.keywordBase;
  const saasTitle = { title: 'Pricing, churn and retention for B2B revenue growth', description: '' };
  assert.ok(D.keywordFactor(saasTitle, CFG, 'saas') > base + 0.4,
    `SaaS 词应显著加分,实际 ${D.keywordFactor(saasTitle, CFG, 'saas')}`);
  // 同一标题按 agentic 组算就只剩基线 —— 证明分组是真的在分,不是把所有词并成一张表
  assert.equal(D.keywordFactor(saasTitle, CFG, 'agentic'), base);
});

test('T30: 主题降权按窗口内出现次数指数衰减', () => {
  const hist = [
    { id: 'a', channel: '@x', topic: 'ai-tech', date: '2026-07-26' },
    { id: 'b', channel: '@y', topic: 'ai-tech', date: '2026-07-25' },
    { id: 'c', channel: '@z', topic: 'ai-tech', date: '2026-07-01' }, // 窗口外
  ];
  const p = CFG.scoring.topicPenalty;
  assert.ok(Math.abs(D.topicFactor('ai-tech', CFG, TODAY, hist) - p * p) < 1e-9,
    '窗口外那条不该计入');
  assert.equal(D.topicFactor('product', CFG, TODAY, hist), 1, '别的主题不受影响');
  assert.equal(D.topicFactor('ai-tech', CFG, TODAY, []), 1, '无历史时不降权');
});

test('T31: 连续出 AI 后,更旧的产品类视频反超(主题扩展是否真的生效)', () => {
  // 两条都是实测真实标题与时长
  const aiVideo = {
    id: 'ai000000001', title: 'The messy reality of scale synthetic data and pre-training',
    channelId: CH('@LatentSpaceTV').channelId, publishedAt: '2026-07-27T02:00:00Z',
    duration: 'PT53M', description: '', liveBroadcastContent: 'none',
  };
  const productVideo = {
    id: 'pd000000001', title: 'Why Netflix is betting on systems thinkers—not specialists—in the AI era',
    channelId: CH('@LennysPodcast').channelId, publishedAt: '2026-07-19T02:00:00Z',
    duration: 'PT72M', description: '', liveBroadcastContent: 'none',
  };

  // 无历史:更新更勤的 AI 类凭 recency 领先 —— 这是改造前的常态
  const a0 = D.scoreVideo(aiVideo, CH('@LatentSpaceTV'), CFG, TODAY, []);
  const p0 = D.scoreVideo(productVideo, CH('@LennysPodcast'), CFG, TODAY, []);
  assert.ok(a0 > p0, `无历史时 AI 类本就该领先(a=${a0} p=${p0}),否则这条测试证明不了降权的作用`);

  // 连续三天 ai-tech,但**分别来自三个不同频道** —— 这样频道降权对本次候选恒为 1,
  // 排序若翻转就只可能是主题降权造成的。
  // (初版这三条都写成 @LatentSpaceTV,结果拿掉 topicFactor 测试照样绿:
  //  翻转其实是频道降权干的,这条测试当时证明不了任何关于主题的事。)
  const hist = [
    { id: 'x1', channel: '@OpenAI', topic: 'ai-tech', date: '2026-07-26' },
    { id: 'x2', channel: '@GoogleDeepMind', topic: 'ai-tech', date: '2026-07-25' },
    { id: 'x3', channel: '@anthropic-ai', topic: 'ai-tech', date: '2026-07-24' },
  ];
  assert.equal(D.diversityFactor(CH('@LatentSpaceTV'), CFG, TODAY, hist), 1,
    '前提校验:本条历史不得触发频道降权,否则测的就不是主题降权');
  const a1 = D.scoreVideo(aiVideo, CH('@LatentSpaceTV'), CFG, TODAY, hist);
  const p1 = D.scoreVideo(productVideo, CH('@LennysPodcast'), CFG, TODAY, hist);
  assert.ok(p1 > a1, `连出三天 AI 后产品类应反超,实际 ai=${a1} product=${p1}`);
});

test('T32: candidates.json 每条都带 topic 字段(下游 Step 3 分模板靠它)', () => {
  const tmp = freshTmp();
  const r = runCli({ script: 'discover.js', args: [
    '--out', tmp, '--from-file', FIXTURE('videos-api-ok.json'), '--today', TODAY] });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(path.join(tmp, 'candidates.json'), 'utf-8'));
  assert.ok(out.candidates.length > 0);
  for (const c of out.candidates) {
    assert.ok(c.topic && CFG.topics[c.topic], `候选 ${c.id} 的 topic 非法: ${c.topic}`);
  }
  assert.match(r.stderr, /topics=\{/, 'stderr 应报出主题分布,便于运维发现主题失衡');
  fs.rmSync(tmp, { recursive: true, force: true });
  r.cleanup();
});

test('T33: 主题判定只看标题,不被频道模板描述带偏(2026-07-28 VM 实测缺陷)', () => {
  // 真实案例:这条标题只按标题算是 ai-tech 2:0,但 AI Engineer 给每条视频挂的
  // 同一段宣传语里满是 agent 字样,一旦把 description 计入就会被判成 agentic ——
  // "按内容判主题"退化成"按频道判主题",主题降权跟着全错。
  const ch = CH('@aiDotEngineer'); // topics: ["agentic", "ai-tech"],agentic 在前
  const video = {
    title: 'The Messy Reality of Scale: Synthetic Data and Pre-Training — Marah Abdin, poolside',
    description: "AI Engineer World's Fair. agentic agent agents mcp eval harness orchestration "
      + 'multi-agent tool use context engineering memory system',
  };
  assert.equal(D.topicOf(video, ch, CFG), 'ai-tech',
    '描述里的频道模板文案不该压过标题里的主题信号');
  // 标题本身没有主题信号时,才允许退回频道第一个主题
  assert.equal(D.topicOf({ title: 'Opening remarks', description: video.description }, ch, CFG), 'agentic');
});
