'use strict';
// resolve-template.js BDD 测试:stdin 解析、退出码映射、缓存写入。
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli, FIXTURE } = require('./helpers');

test('T1: stdin OK → exit 0 + stdout=template_id + 写缓存', () => {
  const r = runCli({
    script: 'resolve-template.js',
    args: ['--from-stdin', '--template-name', 'AI 演讲教程'],
    stdin: fs.readFileSync(FIXTURE('template-getbyname-ok.json'), 'utf-8'),
  });
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'tpl_ai_talk_placeholder');
    const cache = JSON.parse(
      fs.readFileSync(path.join(r.tmp, '.cache', 'ai-talk-tutorial', 'template.json'), 'utf-8')
    );
    assert.equal(cache.template_id, 'tpl_ai_talk_placeholder');
    assert.equal(cache.default_received_convs[0].conversation_id, 'cidPLACEHOLDER==');
  } finally {
    r.cleanup();
  }
});

test('T2: errcode != 0 → exit 2', () => {
  const r = runCli({
    script: 'resolve-template.js',
    args: ['--from-stdin', '--template-name', 'AI 演讲教程'],
    stdin: JSON.stringify({ errcode: 60011, errmsg: 'no permission' }),
  });
  try {
    assert.equal(r.code, 2);
    assert.match(r.stderr, /60011/);
  } finally {
    r.cleanup();
  }
});

test('T3: template_id 缺失 → exit 3', () => {
  const r = runCli({
    script: 'resolve-template.js',
    args: ['--from-stdin', '--template-name', 'AI 演讲教程'],
    stdin: JSON.stringify({ errcode: 0, result: { name: 'x', fields: [] } }),
  });
  try {
    assert.equal(r.code, 3);
  } finally {
    r.cleanup();
  }
});

test('T4: 缺 --template-name → exit 1', () => {
  const r = runCli({ script: 'resolve-template.js', args: ['--from-stdin'] });
  try {
    assert.equal(r.code, 1);
  } finally {
    r.cleanup();
  }
});

test('T5: 无 default_received_convs → WARN 但仍 exit 0', () => {
  const r = runCli({
    script: 'resolve-template.js',
    args: ['--from-stdin', '--template-name', 'AI 演讲教程'],
    stdin: JSON.stringify({ errcode: 0, result: { id: 'tpl_x', fields: [], default_received_convs: [] } }),
  });
  try {
    assert.equal(r.code, 0);
    assert.match(r.stderr, /WARN.*default_received_convs/);
  } finally {
    r.cleanup();
  }
});
