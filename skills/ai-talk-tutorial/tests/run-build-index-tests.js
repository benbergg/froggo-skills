'use strict';
// build-index.js BDD 测试:扫描年份子目录、按日期倒序、跳过 index.html 自身。
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli, freshTmp } = require('./helpers');

function seed(root) {
  fs.mkdirSync(path.join(root, '2026'), { recursive: true });
  const page = (t) => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body></body></html>`;
  fs.writeFileSync(path.join(root, '2026', '2026-07-25-alpha.html'), page('阿尔法演讲'));
  fs.writeFileSync(path.join(root, '2026', '2026-07-27-beta.html'), page('贝塔演讲'));
  fs.writeFileSync(path.join(root, '2026', '2026-07-26-gamma.md'), '# 不该被收录');
}

test('T1: 生成索引,按日期倒序,只收 html', () => {
  const root = freshTmp();
  seed(root);
  const r = runCli({ script: 'build-index.js', args: ['--dir', root] });
  try {
    assert.equal(r.code, 0, r.stderr);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8');
    assert.match(html, /贝塔演讲/);
    assert.match(html, /阿尔法演讲/);
    assert.ok(!/gamma/.test(html), 'md 文件不应进索引');
    assert.ok(html.indexOf('贝塔演讲') < html.indexOf('阿尔法演讲'), '未按日期倒序');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T2: 重跑不重复收录 index.html 自身', () => {
  const root = freshTmp();
  seed(root);
  runCli({ script: 'build-index.js', args: ['--dir', root] }).cleanup();
  const r = runCli({ script: 'build-index.js', args: ['--dir', root] });
  try {
    assert.equal(r.code, 0);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8');
    assert.ok(!/href="[^"]*index\.html"/.test(html), 'index.html 不应收录自身');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T3: 空目录 → 仍产出索引且 exit 0', () => {
  const root = freshTmp();
  const r = runCli({ script: 'build-index.js', args: ['--dir', root] });
  try {
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(root, 'index.html')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T4: 标题含 & < > → 索引页显示明文,不双重转义(F1 修复)', () => {
  const root = freshTmp();
  fs.mkdirSync(path.join(root, '2026'), { recursive: true });
  // 模拟 Task 4 build-html.js 的真实产出:<title> 内容已被 esc() 转义过一遍。
  const page = '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>Bug &amp; Fix &lt;urgent&gt;</title></head><body></body></html>';
  fs.writeFileSync(path.join(root, '2026', '2026-07-20-escaped.html'), page);
  const r = runCli({ script: 'build-index.js', args: ['--dir', root] });
  try {
    assert.equal(r.code, 0, r.stderr);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8');
    // 单重转义:原文 "Bug & Fix <urgent>" 应恰好转义一次
    assert.match(html, /Bug &amp; Fix &lt;urgent&gt;/);
    // 不应出现双重转义(&amp;amp; / &amp;lt; / &amp;gt;)
    assert.ok(!/&amp;amp;/.test(html), '出现双重转义 &amp;amp;');
    assert.ok(!/&amp;lt;/.test(html), '出现双重转义 &amp;lt;');
    assert.ok(!/&amp;gt;/.test(html), '出现双重转义 &amp;gt;');
    // 也不应把原始标记未转义地拼进页面(会破坏 HTML 结构)
    assert.ok(!/Bug & Fix <urgent>/.test(html), '出现未转义的原始标记');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T5: 文件名不符 YYYY-MM-DD-slug.html → 跳过', () => {
  const root = freshTmp();
  fs.mkdirSync(path.join(root, '2026'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '2026', 'not-a-date.html'),
    '<!doctype html><html><head><title>不该被收录的标题</title></head><body></body></html>'
  );
  const r = runCli({ script: 'build-index.js', args: ['--dir', root] });
  try {
    assert.equal(r.code, 0, r.stderr);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8');
    assert.ok(!/不该被收录的标题/.test(html), '不合日期格式的文件名不应被收录');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    r.cleanup();
  }
});

// ---- FR3(最终修复轮):build-html.js 的 esc() 加了 &quot; 转义之后,归档 HTML 的
// <title> 里可能出现 &quot;(标题含 ASCII 直引号时),collect()+unesc() 若不同步支持
// 解码 &quot;,会把它当普通文本传给 render() 的 esc() 重新转义一次,产生
// &quot; → &amp;quot; 的双重转义(Task 5 T4 已经验证过 &amp;/&lt;/&gt; 不能双重转义,
// 这里补上 &quot; 这一路径,防止把 Task 5 修好的往返自洽性弄坏)。

test('T6: 标题含 " 且已被 build-html.js 的 esc() 转义为 &quot; → 索引页单重转义,不产生 &amp;quot;(FR3 往返自洽性)', () => {
  const root = freshTmp();
  fs.mkdirSync(path.join(root, '2026'), { recursive: true });
  // 模拟 build-html.js 加了 &quot; 转义后的真实产出:标题原文是
  // 论 "Vibe Coding" 的三层 <演进>,esc() 之后 <title> 里是这样:
  const page = '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>论 &quot;Vibe Coding&quot; 的三层 &lt;演进&gt;</title></head><body></body></html>';
  fs.writeFileSync(path.join(root, '2026', '2026-07-21-quoted.html'), page);
  const r = runCli({ script: 'build-index.js', args: ['--dir', root] });
  try {
    assert.equal(r.code, 0, r.stderr);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8');
    // 单重转义:原文 论 "Vibe Coding" 的三层 <演进> 应恰好转义一次
    assert.match(html, /论 &quot;Vibe Coding&quot; 的三层 &lt;演进&gt;/);
    // 不应出现双重转义
    assert.ok(!/&amp;quot;/.test(html), '出现双重转义 &amp;quot;');
    assert.ok(!/&amp;lt;/.test(html), '出现双重转义 &amp;lt;');
    assert.ok(!/&amp;gt;/.test(html), '出现双重转义 &amp;gt;');
    // 也不应把原始引号未转义地拼进属性上下文(index.html 里标题在 <a> 文本内容,
    // 不在属性里,但未转义的裸 " 混入仍是不该出现的原始标记泄漏)
    assert.ok(!/论 "Vibe Coding" 的三层 <演进>/.test(html), '出现未转义的原始标记');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T7: 年份子目录名非 4 位数字 → 跳过', () => {
  const root = freshTmp();
  fs.mkdirSync(path.join(root, 'notyear'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'notyear', '2026-01-01-x.html'),
    '<!doctype html><html><head><title>不该被收录的年份目录</title></head><body></body></html>'
  );
  const r = runCli({ script: 'build-index.js', args: ['--dir', root] });
  try {
    assert.equal(r.code, 0, r.stderr);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8');
    assert.ok(!/不该被收录的年份目录/.test(html), '非 4 位数字年份目录不应被扫描');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    r.cleanup();
  }
});
