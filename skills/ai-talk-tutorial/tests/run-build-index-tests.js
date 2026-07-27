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
