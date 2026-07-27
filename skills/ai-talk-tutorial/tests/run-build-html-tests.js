'use strict';
// build-html.js BDD 测试:五段解析、C1-C8 自检(含故意造假验证 C3/C4)、渲染。
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli, FIXTURE, freshTmp } = require('./helpers');

const B = require('../references/scripts/build-html.js');

const TRANSCRIPT = {
  video_id: 'aaaaaaaaaaa', title: 'How we built agentic evals', channel: 'AI Engineer',
  duration_sec: 2480, via: 'android', cue_count: 100,
  segments: [
    { start: 0,   startLabel: '0:00',  text: 'welcome everyone today we talk about agents' },
    { start: 45,  startLabel: '0:45',  text: 'evaluation comes first not the model' },
    { start: 754, startLabel: '12:34', text: 'you cannot improve what you do not measure' },
  ],
  full_text: 'welcome everyone today we talk about agents evaluation comes first not the model you cannot improve what you do not measure',
};
const SELECTED = {
  id: 'aaaaaaaaaaa', title: 'How we built agentic evals', channelTitle: 'AI Engineer',
  channelHandle: '@aiDotEngineer', durationSec: 2480,
  url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
};

function load(name) { return fs.readFileSync(FIXTURE(name), 'utf-8'); }

test('T1: 五段结构解析', () => {
  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  assert.ok(doc.title.length > 0);
  for (const k of ['tldr', 'background', 'method', 'checklist', 'quotes']) {
    assert.ok(doc.sections[k] && doc.sections[k].length > 0, `缺段落: ${k}`);
  }
  assert.ok(doc.quotes.length >= 1);
  assert.equal(doc.quotes[0].sec, 754);
  assert.match(doc.quotes[0].en, /cannot improve/);
});

test('T2: 合格文档 → 零违规', () => {
  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  const v = B.runChecks(doc, TRANSCRIPT, SELECTED);
  assert.deepEqual(v, [], `期望零违规,实际: ${JSON.stringify(v)}`);
});

test('T3: C1 — 缺段落被拦', () => {
  const md = load('tutorial-good.md').replace(/## 四、可落地 checklist[\s\S]*?(?=## 五、)/, '');
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C1'), `期望 C1,实际 ${JSON.stringify(v)}`);
});

test('T4: C2 — 时间戳超过视频总时长被拦', () => {
  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  doc.quotes[0].sec = 99999;
  doc.quotes[0].label = '1666:39';
  const v = B.runChecks(doc, TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C2'));
});

test('T5: C3 — 伪造时间戳被拦(核心)', () => {
  const doc = B.parseTutorialMd(load('tutorial-fake-timestamp.md'));
  const v = B.runChecks(doc, TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C3'), `C3 未拦住伪造时间戳: ${JSON.stringify(v)}`);
});

test('T6: C4 — 伪造金句被拦(核心)', () => {
  const doc = B.parseTutorialMd(load('tutorial-fake-quote.md'));
  const v = B.runChecks(doc, TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C4'), `C4 未拦住伪造金句: ${JSON.stringify(v)}`);
});

test('T7: C5 — 方法论步骤 <3 被拦', () => {
  const md = load('tutorial-good.md').replace(/### 3\.[\s\S]*?(?=## 四、)/, '');
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C5'));
});

test('T8: C6 — 占位符被拦', () => {
  const md = load('tutorial-good.md').replace('先搭最小评估集', 'TODO: 补充');
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C6'));
});

test('T9: C7 — 标题与 selected.json 不符被拦', () => {
  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  const v = B.runChecks(doc, TRANSCRIPT, { ...SELECTED, id: 'zzzzzzzzzzz' });
  assert.ok(v.some((x) => x.code === 'C7'));
});

test('T10: C8 — 正文成段英文被拦', () => {
  const md = load('tutorial-good.md').replace(
    '他把评估放在模型之前。',
    'He argues that evaluation should always come before any model selection decision whatsoever.'
  );
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C8'));
});

test('T11: CLI 合格 → exit 0 + 产出自包含 HTML', () => {
  const out = freshTmp();
  const tPath = path.join(out, 't.json');
  const sPath = path.join(out, 's.json');
  const hPath = path.join(out, 'tutorial.html');
  fs.writeFileSync(tPath, JSON.stringify(TRANSCRIPT));
  fs.writeFileSync(sPath, JSON.stringify(SELECTED));
  const r = runCli({
    script: 'build-html.js',
    args: ['--md', FIXTURE('tutorial-good.md'), '--transcript', tPath, '--selected', sPath, '--out', hPath],
  });
  try {
    assert.equal(r.code, 0, `expected 0, got ${r.code}: ${r.stderr}`);
    const html = fs.readFileSync(hPath, 'utf-8');
    assert.match(html, /<meta charset="utf-8">/i, '缺 charset,中文会乱码');
    assert.ok(!/<!--[A-Z_]+-->/.test(html), '模板锚点未全部替换');
    assert.ok(!/src="http|href="http[^"]*\.css|<script src=/.test(html.replace(/(?:href|src)="https:\/\/www\.youtube\.com[^"]*"/g, '')),
      '存在外部资源引用,违反自包含要求');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T12: CLI 自检失败 → exit 5 + stderr 列违规码', () => {
  const out = freshTmp();
  const tPath = path.join(out, 't.json');
  const sPath = path.join(out, 's.json');
  const hPath = path.join(out, 'tutorial.html');
  fs.writeFileSync(tPath, JSON.stringify(TRANSCRIPT));
  fs.writeFileSync(sPath, JSON.stringify(SELECTED));
  const r = runCli({
    script: 'build-html.js',
    args: ['--md', FIXTURE('tutorial-fake-quote.md'), '--transcript', tPath, '--selected', sPath, '--out', hPath],
  });
  try {
    assert.equal(r.code, 5, `expected 5, got ${r.code}`);
    assert.match(r.stderr, /C4/);
    assert.equal(fs.existsSync(hPath), false, '自检失败时不得产出 HTML(物理断路)');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

// ---- 评审 fix round F1:C3 从"只比时间"改为"比时间窗口内的文本" -----------
// 下面两条覆盖原实现的两个独立失效模式(评审实跑验证过):
// 1) 真金句配一个真实但错误的时间戳 —— 旧实现只看 s.start 与 q.sec 的数值距离,直接放行。
// 2) 密集 cue(真实 YouTube 字幕间距约 2-5s)下旧实现几乎不可能触发 —— 证明新逻辑不依赖稀疏夹具。

test('T13: C3 — 真金句配真实但错误的时间戳被拦(拦"时间对了但文本不对"这种伪造)', () => {
  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  // 0:45 是 TRANSCRIPT 中真实存在的段落起点,但那段文本是
  // "evaluation comes first not the model",与金句原文无关。
  doc.quotes[0].sec = 45;
  doc.quotes[0].label = '0:45';
  const v = B.runChecks(doc, TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C3'), `真实时间戳但文本错配未被 C3 拦住: ${JSON.stringify(v)}`);
  // 金句英文原句本身仍逐字存在于 full_text 中,C4 不应报错 —— 证明这是 C3 独立捕获的失效模式
  assert.ok(!v.some((x) => x.code === 'C4'), `C4 不应因这种错配触发: ${JSON.stringify(v)}`);
});

test('T14: C3 — 密集 cue transcript 下仍能拦住错配时间戳(不依赖稀疏夹具)', () => {
  // 构造每 4s 一段的密集 transcript(贴近真实字幕 cue 间距),覆盖 0-200s
  const denseSegments = [];
  for (let s = 0; s <= 200; s += 4) {
    denseSegments.push({
      start: s,
      startLabel: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
      text: `filler segment at ${s} seconds nothing special here`,
    });
  }
  // 在真实时间点 100s 处放入真金句文本
  const targetIdx = denseSegments.findIndex((seg) => seg.start === 100);
  denseSegments[targetIdx] = {
    start: 100, startLabel: '1:40', text: 'you cannot improve what you do not measure',
  };
  const denseTranscript = {
    video_id: 'aaaaaaaaaaa', title: 'x', channel: 'x', duration_sec: 200, via: 'android',
    cue_count: denseSegments.length,
    segments: denseSegments,
    full_text: denseSegments.map((seg) => seg.text).join(' '),
  };

  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  // 金句文本不变(真实存在于 100s),但把时间戳错配到密集 transcript 中另一个真实存在的 cue(20s,纯 filler)
  doc.quotes[0].sec = 20;
  doc.quotes[0].label = '0:20';
  const v = B.runChecks(doc, denseTranscript, SELECTED);
  assert.ok(v.some((x) => x.code === 'C3'), `密集 cue 场景下 C3 未拦住错配: ${JSON.stringify(v)}`);
});

// ---- 评审 fix round F2:C6 中文占位符因 \b 边界失效 ------------------------

test('T15: C6 — 中文占位符"待补充"被拦(不依赖 TODO 这类英文词命中)', () => {
  const md = load('tutorial-good.md').replace('把样本固化为可重放用例', '待补充');
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C6'), `中文占位符"待补充"未被 C6 拦住: ${JSON.stringify(v)}`);
});

// ---- 评审 fix round F5:C8 句级判定回归了长度阈值,整行纯英文短句拼接被放行 -----

test('T16: C8 — 整行纯英文但拆句后逐句都 <40 字符仍被拦(F5 回归修复)', () => {
  const md = load('tutorial-good.md').replace(
    '团队在把 agent 推上生产时，常常先挑模型再补评估，结果无法判断改动是否带来提升。他把评估放在模型之前。',
    'Eval first. Model second. Data always. Ship fast and measure.'
  );
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C8'), `整行纯英文短句拼接未被 C8 拦住: ${JSON.stringify(v)}`);
});

// ---- 评审 fix round F6:C3 窗口需覆盖"金句跨相邻合并段"的生产形态 -------------
// fetch-transcript.js 的 mergeSegments({minSec:30,maxSec:60}) 把真实字幕合并成 30-60s 大段
// (transcript-real.json 实测段间距 31-62s)。纯按 start 落在 ±TOL 窗口内选段,
// 会在"金句跨相邻两段、时间戳取前段 start"时漏掉后半句所在的下一段,造成假阳性 C3。

test('T17: C3 — 金句跨相邻合并段(30-60s 间距)、时间戳取前段 start 时不误报', () => {
  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  doc.quotes[0].sec = 300;
  doc.quotes[0].label = '5:00';
  doc.quotes[0].en = 'you cannot improve what you do not measure';
  const mergedTranscript = {
    video_id: 'aaaaaaaaaaa', title: 'x', channel: 'x', duration_sec: 500, via: 'android', cue_count: 2,
    segments: [
      { start: 300, startLabel: '5:00', text: "let's talk about evaluation strategy. you cannot improve" },
      { start: 345, startLabel: '5:45', text: 'what you do not measure so build evals first' },
    ],
    full_text: "let's talk about evaluation strategy. you cannot improve what you do not measure so build evals first",
  };
  const v = B.runChecks(doc, mergedTranscript, SELECTED);
  assert.ok(!v.some((x) => x.code === 'C3'), `跨段金句被误报 C3: ${JSON.stringify(v)}`);
});

test('T18: C3 — 放宽窗口后,真实错配(时间戳真实但金句不在附近)依然被拦', () => {
  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  doc.quotes[0].sec = 40;
  doc.quotes[0].label = '0:40';
  doc.quotes[0].en = 'you cannot improve what you do not measure';
  const mergedTranscript = {
    video_id: 'aaaaaaaaaaa', title: 'x', channel: 'x', duration_sec: 200, via: 'android', cue_count: 4,
    segments: [
      { start: 0,   startLabel: '0:00', text: 'welcome to the show today we have a great guest' },
      { start: 40,  startLabel: '0:40', text: "let's talk about product strategy and roadmap decisions" },
      { start: 95,  startLabel: '1:35', text: 'here is another unrelated segment about pricing model' },
      { start: 150, startLabel: '2:30', text: 'you cannot improve what you do not measure said the speaker' },
    ],
    full_text: [
      'welcome to the show today we have a great guest',
      "let's talk about product strategy and roadmap decisions",
      'here is another unrelated segment about pricing model',
      'you cannot improve what you do not measure said the speaker',
    ].join(' '),
  };
  const v = B.runChecks(doc, mergedTranscript, SELECTED);
  assert.ok(v.some((x) => x.code === 'C3'), `放宽窗口后仍应拦住真实错配: ${JSON.stringify(v)}`);
});

// ---- 评审 fix round F7:C4 的独有拦截带需要测试覆盖 ------------------------
// C3 变强后,C4 继续存在的唯一理由是"语序改写、词全在、时间戳真实"这条带:
// token 重叠率会算出 1.0 放行 C3,只有 C4 的精确子串匹配能拦住。

test('T19: C4 独有拦截带 — 语序改写、词全在、时间戳真实,仅 C4 触发', () => {
  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  // 与原句同词不同序;时间戳(754s / 12:34)保持真实不变
  doc.quotes[0].en = 'what you do not measure you cannot improve';
  const v = B.runChecks(doc, TRANSCRIPT, SELECTED);
  assert.ok(!v.some((x) => x.code === 'C3'), `语序改写不应触发 C3(token 重叠应放行): ${JSON.stringify(v)}`);
  assert.ok(v.some((x) => x.code === 'C4'), `语序改写应被 C4 精确子串匹配拦住: ${JSON.stringify(v)}`);
});
