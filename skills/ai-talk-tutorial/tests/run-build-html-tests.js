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
  const md = load('tutorial-good.md').replace('第二句', 'TODO: 补充');
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
