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

test('T9: C7 — video_id 与 selected.json 不符被拦(注:全流程无标题一致性校验,见 SKILL.md 诚实上限)', () => {
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

// ---- 端到端验收缺陷 1:金句部分损坏(中文弯引号)被静默丢弃,自检无感 -------------
// tutorial-partial-broken-quote.md 写了 2 条金句,第 2 条把英文部分的 ASCII 直引号
// 换成了中文弯引号 "…"。qRe 只认 ASCII "",这一条会从 doc.quotes 里彻底消失且不报错,
// 只有当"全部"金句都坏掉(doc.quotes.length===0)才会触发旧的 C4「未提供任何原声金句」。
// 本条验证:解析阶段能区分"这行看起来是金句但没解析出来"与"这里根本没有金句行",
// 数量不一致时必须报违规,且报错要点名弯引号这个最常见成因(不能让 3 轮修复循环瞎猜)。

test('T20: C4 — 部分金句因弯引号被静默丢弃时必须报违规(缺陷1)', () => {
  const doc = B.parseTutorialMd(load('tutorial-partial-broken-quote.md'));
  // 先确认这份夹具确实复现了"静默丢弃"这个现象本身(不是测试写错了)
  assert.equal(doc.quotes.length, 1, '夹具应复现:弯引号那条解析失败,只剩 1 条金句');
  const v = B.runChecks(doc, TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C4' && /弯引号/.test(x.message)),
    `期望 C4 报出部分金句丢失且点名弯引号成因,实际: ${JSON.stringify(v)}`);
});

// ---- 端到端验收缺陷 2:C2 拿 duration_sec 当权威,与实际字幕时间轴不一致时误杀真金句 ----
// transcript-real.json(未被任何既有测试引用的真实夹具,Task 3 遗留的 deferred Minor)原本
// duration_sec=2480,但最后一段 start=2928(48:48),76 段里有 12 段(16%)超出 duration_sec ——
// 这份转录本身是真的(结尾文本连贯,约 49 分钟的真实演讲),错的是 duration_sec 这个值
// (来自 YouTube Data API 的 contentDetails.duration,与实际下载的字幕轴来源不同,可能不一致)。
// 本轮修复已把夹具自身的 duration_sec 改成与字幕轴自洽的 2970(见 fixtures 变更说明),
// 所以这里用同一份真实 segments/full_text,单独构造一个更小的 duration_sec(取验收实测
// 发现的真实错值 2480)来复现"来源不一致"这个场景本身 —— 不依赖夹具自身再存一个错值。
// 本条验证:落在最后一段真实时间点上的真金句不应被 C2 误杀。

test('T21: C2 — duration_sec 与实际字幕轴不一致时,真实存在的金句不应被误杀(缺陷2,用 transcript-real.json)', () => {
  const transcriptReal = JSON.parse(fs.readFileSync(FIXTURE('transcript-real.json'), 'utf-8'));
  const selectedReal = JSON.parse(fs.readFileSync(FIXTURE('selected-real.json'), 'utf-8'));
  assert.equal(transcriptReal.video_id, selectedReal.id, '夹具前提:video_id 与 selected.id 一致(排除 C7 干扰)');
  const lastSeg = transcriptReal.segments[transcriptReal.segments.length - 1];

  // 用真实 segments/full_text,叠加验收实测发现的真实错值 duration_sec=2480,
  // 复现"YouTube Data API 的 duration_sec 与实际字幕轴不一致"这个场景本身
  const transcriptWithStaleDuration = { ...transcriptReal, duration_sec: 2480 };
  assert.ok(lastSeg.start > transcriptWithStaleDuration.duration_sec,
    '夹具前提:最后一段 start 应超出模拟的 stale duration_sec(复现"来源不一致"这个现象本身)');

  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  doc.quotes[0].sec = lastSeg.start;
  doc.quotes[0].label = lastSeg.startLabel;
  doc.quotes[0].en = "And then you're just going to tell yourself I'm going to learn my way there.";
  const v = B.runChecks(doc, transcriptWithStaleDuration, selectedReal);
  assert.ok(!v.some((x) => x.code === 'C2'),
    `真实字幕轴上存在的金句不应被 C2 误杀: ${JSON.stringify(v)}`);
});

test('T22: C2 — 放宽上界后,真正编造的时间戳(远超字幕轴与 duration_sec)依然被拦(用 transcript-real.json)(护栏,非判别 —— 见 T21 判别测试)', () => {
  const transcriptReal = JSON.parse(fs.readFileSync(FIXTURE('transcript-real.json'), 'utf-8'));
  const selectedReal = JSON.parse(fs.readFileSync(FIXTURE('selected-real.json'), 'utf-8'));

  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  doc.quotes[0].sec = 99999;
  doc.quotes[0].label = '1666:39';
  const v = B.runChecks(doc, transcriptReal, selectedReal);
  assert.ok(v.some((x) => x.code === 'C2'), `明显编造的时间戳应仍被 C2 拦住: ${JSON.stringify(v)}`);
});

// ---- FR1(最终修复轮):C1/C5 只判"段落非空"/"步骤数与标题非空",完全不检查
// 段落"正文"内容 —— 一份 TL;DR 一行、背景一句"略。"、三个空标题步骤、checklist 一项、
// 一条真实金句的骨架文档能通过全部自检并被广播(SKILL.md:163 的"每步须有标题和正文"
// 约束没有任何脚本落地)。本轮加:
//   C5 每步正文最小长度 STEP_BODY_MIN_CHARS=15 —— 阈值依据:tutorial-good.md 三步
//     真实正文分别是 22/27/24 字符(单句中文方法论描述的下限),15 留出安全余量、
//     同时能拦住 tutorial-hollow.md 里完全空白(0 字符)的正文,不会误伤真实产出。
//   C1 tldr/checklist ≥2 条(TLDR_MIN_BULLETS/CHECKLIST_MIN_ITEMS)—— tutorial-good.md
//     两处均为 3 条,阈值 2 留出至少 1 条的余量,同时能拦住骨架文档的单条。
//   C1 background ≥30 字符(BACKGROUND_MIN_CHARS)—— tutorial-good.md 背景段实测 54 字符
//     (评审建议的 60 反而会误杀这份合格夹具,故未采用),30 留出接近一半的余量,
//     同时远高于骨架文档"略。"的 2 字符。
//   C1 H1 ≥6 字符(H1_MIN_CHARS,采用评审建议值)—— tutorial-good.md 标题实测 20 字符,
//     骨架文档标题"AI 教程"只有 5 字符,刚好落在阈值之下。
// 每条阈值均已用 T2(tutorial-good.md → 零违规)验证不会误伤合格产出。

test('T23: FR1 — 结构合法但内容空洞的骨架文档被 C1+C5 拦(核心判别用例)', () => {
  const doc = B.parseTutorialMd(load('tutorial-hollow.md'));
  const v = B.runChecks(doc, TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C1'), `期望骨架文档触发 C1,实际: ${JSON.stringify(v)}`);
  assert.ok(v.some((x) => x.code === 'C5'), `期望骨架文档触发 C5(步骤正文空洞),实际: ${JSON.stringify(v)}`);
  // 确认不是靠 C2/C3/C4/C6/C7/C8 这些既有检查误撞上的 —— 骨架文档的时间戳/金句/占位符/
  // video_id 都是"合法"的,唯独正文内容空洞,只应由新增的 C1/C5 内容深度检查拦住
  assert.ok(!v.some((x) => ['C2', 'C3', 'C4', 'C6', 'C7', 'C8'].includes(x.code)),
    `骨架文档不应触发 C2/C3/C4/C6/C7/C8,实际: ${JSON.stringify(v)}`);
});

test('T24: FR1 — CLI 层面骨架文档同样 exit 5,不产出 HTML(物理断路)', () => {
  const out = freshTmp();
  const tPath = path.join(out, 't.json');
  const sPath = path.join(out, 's.json');
  const hPath = path.join(out, 'tutorial.html');
  fs.writeFileSync(tPath, JSON.stringify(TRANSCRIPT));
  fs.writeFileSync(sPath, JSON.stringify(SELECTED));
  const r = runCli({
    script: 'build-html.js',
    args: ['--md', FIXTURE('tutorial-hollow.md'), '--transcript', tPath, '--selected', sPath, '--out', hPath],
  });
  try {
    assert.equal(r.code, 5, `expected 5, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /C1/);
    assert.match(r.stderr, /C5/);
    assert.equal(fs.existsSync(hPath), false, '骨架文档不应产出 HTML');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T25: C5 — 单步正文过短(<15 字符)被拦,即便标题非空(FR1)', () => {
  const md = load('tutorial-good.md').replace(
    '### 1. 先定义失败样本\n从真实流量里挑出失败案例，作为评估集的种子。',
    '### 1. 先定义失败样本\n太短。'
  );
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C5' && /正文过短/.test(x.message)),
    `期望正文过短被 C5 拦住,实际: ${JSON.stringify(v)}`);
});

test('T26: C1 — TL;DR 只有 1 条 bullet 被拦(FR1)', () => {
  const md = load('tutorial-good.md').replace(
    /## 一、\s*TL;DR\n\n[\s\S]*?(?=\n## 二、)/,
    '## 一、TL;DR\n\n- 只有一条。'
  );
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C1' && /TL;DR/.test(x.message)),
    `期望 TL;DR 条目过少被 C1 拦住,实际: ${JSON.stringify(v)}`);
});

test('T27: C1 — checklist 只有 1 项被拦(FR1)', () => {
  const md = load('tutorial-good.md').replace(
    /## 四、可落地 checklist\n\n[\s\S]*?(?=\n## 五、)/,
    '## 四、可落地 checklist\n\n- [ ] 只有一项。\n'
  );
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C1' && /checklist/.test(x.message)),
    `期望 checklist 条目过少被 C1 拦住,实际: ${JSON.stringify(v)}`);
});

test('T28: C1 — 背景段落过短(<30 字符)被拦(FR1)', () => {
  const md = load('tutorial-good.md').replace(
    '团队在把 agent 推上生产时，常常先挑模型再补评估，结果无法判断改动是否带来提升。他把评估放在模型之前。',
    '略。'
  );
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C1' && /背景段落过短/.test(x.message)),
    `期望背景过短被 C1 拦住,实际: ${JSON.stringify(v)}`);
});

test('T29: C1 — H1 标题过短(<6 字符)被拦(FR1)', () => {
  const md = load('tutorial-good.md').replace(
    '# 如何构建能上生产的 Agent 评估体系',
    '# AI 教程'
  );
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C1' && /H1 标题过短/.test(x.message)),
    `期望 H1 过短被 C1 拦住,实际: ${JSON.stringify(v)}`);
});

// FR1 收尾:countListItems 原本只认 `-`/`*`,而 SKILL.md 的撰写约束并未禁止编号写法。
// 一份内容完整但用 `1.` 写 TL;DR 的文档会被 C1 判成"条目过少…内容空洞"而中止当天流水线,
// 且该文案会把 3 轮修复循环引向"重写内容"而不是"换标记符"——假阳性比漏放更糟。
test('T32: TL;DR 用编号列表(1./2./3.)书写不被 C1 误判为内容空洞', () => {
  const md = load('tutorial-good.md');
  let n = 0;
  const numbered = md.split('\n')
    .map((l) => (/^- /.test(l) && n < 3 ? `${++n}. ${l.slice(2)}` : l))
    .join('\n');
  assert.equal(n, 3, '夹具的 TL;DR 应有 3 条 bullet 可供改写');
  const v = B.runChecks(B.parseTutorialMd(numbered), TRANSCRIPT, SELECTED);
  assert.deepEqual(v, [], `编号列表不应触发任何违规,实际: ${JSON.stringify(v)}`);
});

// ---- FR3:esc() 不转义 " 却被用在 HTML 属性上下文(title="..."/href="...")------------
// H1 写成 `# 论 "Vibe Coding" 的三层 <演进>`(SKILL.md:166 要求金句用 ASCII 直引号,
// 容易带偏模型在全文含 H1 都用 ""),产出的 iframe title 属性会在第二个 " 处提前闭合,
// 后续 allowfullscreen 等 token 被解析成伪属性 —— 归档 HTML 是最终交付物,命中概率不低。

test('T30: H1 含 ASCII 直引号与尖括号 → title/href 属性正确转义为 &quot;/&lt;/&gt;,不提前闭合(FR3)', () => {
  const out = freshTmp();
  const mdPath = path.join(out, 't.md');
  const tPath = path.join(out, 't.json');
  const sPath = path.join(out, 's.json');
  const hPath = path.join(out, 'tutorial.html');
  const md = load('tutorial-good.md').replace(
    '# 如何构建能上生产的 Agent 评估体系',
    '# 论 "Vibe Coding" 的三层 <演进> 方法体系'
  );
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(tPath, JSON.stringify(TRANSCRIPT));
  fs.writeFileSync(sPath, JSON.stringify(SELECTED));
  const r = runCli({
    script: 'build-html.js',
    args: ['--md', mdPath, '--transcript', tPath, '--selected', sPath, '--out', hPath],
  });
  try {
    assert.equal(r.code, 0, `expected 0, got ${r.code}: ${r.stderr}`);
    const html = fs.readFileSync(hPath, 'utf-8');
    // title 属性值必须是单个完整、正确转义的字符串 —— 提前闭合会导致后面出现
    // 裸露的 Vibe Coding" 之类残片,或 allowfullscreen 被解析成 title 值的一部分
    assert.match(html, /title="论 &quot;Vibe Coding&quot; 的三层 &lt;演进&gt; 方法体系"/,
      'iframe title 属性未正确转义 "/<>');
    assert.match(html, /allowfullscreen loading="lazy"><\/iframe>/, 'title 属性提前闭合,后续属性解析错乱');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

// ---- FR4:自检失败(exit 5)时不删除已存在的 --out 文件,同日重跑会归档陈旧 HTML -------

test('T31: 自检失败(exit 5)时删除已存在的旧 --out 文件,防止同日重跑归档陈旧 HTML(FR4)', () => {
  const out = freshTmp();
  const tPath = path.join(out, 't.json');
  const sPath = path.join(out, 's.json');
  const hPath = path.join(out, 'tutorial.html');
  fs.writeFileSync(tPath, JSON.stringify(TRANSCRIPT));
  fs.writeFileSync(sPath, JSON.stringify(SELECTED));
  fs.writeFileSync(hPath, '<html>STALE FROM YESTERDAY</html>');
  const r = runCli({
    script: 'build-html.js',
    args: ['--md', FIXTURE('tutorial-fake-quote.md'), '--transcript', tPath, '--selected', sPath, '--out', hPath],
  });
  try {
    assert.equal(r.code, 5, `expected 5, got ${r.code}: ${r.stderr}`);
    assert.equal(fs.existsSync(hPath), false, '自检失败后旧 HTML 未被删除,同日重跑会把它当今日产出归档广播');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

// ---- 方案 C(2026-07-28):正文 callout 疏堵结合。
// 实证问题:7-28 产出的教程里 AI 自发写了 `> [!tip]` 提示块,渲染结果是
// `<p>&gt; [!tip] &gt; 关键工程法则:…</p>` —— `[!tip]` 字面泄漏、`>` 转义成 &gt;、
// 样式全丢。根因是正文渲染只认段落和列表,`>` 一律走 esc();而撰写约束里没有
// 任何一条禁止这么写。AI 有表达需求,堵不如疏:支持封闭的三种 callout,
// 其余任何以 `>` 开头的正文行由 C6 拦下 exit 5(金句段豁免 —— 那里 `>` 是格式本身)。

const CALLOUT_MD = load('tutorial-good.md').replace(
  '### 2. 建立可重放的评估集',
  `> [!tip]
> 关键工程法则:**任务过难模型就会崩**,所以要持续拆解到模型跑得动为止。

### 2. 建立可重放的评估集`
);

test('T33: 合法 callout 渲染成样式块,不泄漏 [!tip] 字面量、不出现 &gt;(生产实证形态)', () => {
  const doc = B.parseTutorialMd(CALLOUT_MD);
  const v = B.runChecks(doc, TRANSCRIPT, SELECTED);
  assert.deepEqual(v.filter((x) => x.code === 'C6'), [], `合法 callout 不该触发 C6: ${JSON.stringify(v)}`);
  const html = B.renderHtml(doc, SELECTED, fs.readFileSync(
    path.join(__dirname, '..', 'references', 'templates', 'tutorial.html'), 'utf-8'));
  const method = html.slice(html.indexOf('id="method"'), html.indexOf('id="checklist"'));
  assert.doesNotMatch(method, /\[!tip\]/, 'callout 标记不该以字面量出现在正文里');
  assert.doesNotMatch(method, /&gt;\s*关键工程法则/, '`>` 不该被当普通文本转义成 &gt;');
  assert.match(method, /class="callout callout-tip"/, '应渲染为 callout 样式块');
  assert.match(method, /关键工程法则/, 'callout 正文必须保留');
  assert.match(method, /<strong>任务过难模型就会崩<\/strong>/, 'callout 内的行内粗体应继续生效');
});

test('T34: 未支持的 callout 类型(如 [!abstract])被 C6 拦 —— 封闭集合,不是任意 Obsidian 语法', () => {
  const md = CALLOUT_MD.replace('[!tip]', '[!abstract]');
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C6'), `期望 C6 拦住未支持的 callout 类型,实际: ${JSON.stringify(v)}`);
  assert.match(v.find((x) => x.code === 'C6').message, /tip|warning|note/,
    'C6 文案必须列出允许的类型,否则 AI 的修复循环只能瞎猜');
});

test('T35: 正文里的裸 `>` 引用行被 C6 拦(渲染层不支持,写了就是破版)', () => {
  const md = load('tutorial-good.md').replace(
    '### 2. 建立可重放的评估集',
    `> 这是一句被当成引用写的普通话,渲染层并不支持。

### 2. 建立可重放的评估集`
  );
  const v = B.runChecks(B.parseTutorialMd(md), TRANSCRIPT, SELECTED);
  assert.ok(v.some((x) => x.code === 'C6'), `期望 C6 拦住裸 > 引用,实际: ${JSON.stringify(v)}`);
});

test('T36: 金句段的 `>` 不被 C6 误伤(那里 `>` 是金句格式本身)', () => {
  const doc = B.parseTutorialMd(load('tutorial-good.md'));
  const v = B.runChecks(doc, TRANSCRIPT, SELECTED);
  assert.deepEqual(v, [], `合格文档(金句段满是 >)必须零违规: ${JSON.stringify(v)}`);
});

test('T37: 背景段的 callout 同样生效(不只 method 段)', () => {
  const md = load('tutorial-good.md').replace(
    '## 三、核心方法论',
    `> [!warning]
> 这里有一个容易踩的坑,先说清楚再往下看。

## 三、核心方法论`
  );
  const doc = B.parseTutorialMd(md);
  assert.deepEqual(B.runChecks(doc, TRANSCRIPT, SELECTED).filter((x) => x.code === 'C6'), []);
  const html = B.renderHtml(doc, SELECTED, fs.readFileSync(
    path.join(__dirname, '..', 'references', 'templates', 'tutorial.html'), 'utf-8'));
  assert.match(html, /class="callout callout-warning"/);
});

test('T38: 模板提供 callout 样式,浅色与深色都有定义(渲染出 class 却没样式 = 白做)', () => {
  const tpl = fs.readFileSync(
    path.join(__dirname, '..', 'references', 'templates', 'tutorial.html'), 'utf-8');
  assert.match(tpl, /\.callout\s*\{/, '模板缺少 .callout 基础样式');
  for (const t of ['tip', 'warning', 'note']) {
    assert.match(tpl, new RegExp(`\\.callout-${t}\\s*\\{`), `模板缺少 .callout-${t} 样式`);
  }
});
