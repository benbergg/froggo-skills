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

test('T6: 年份子目录名非 4 位数字 → 跳过', () => {
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
