'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli, FIXTURE } = require('./helpers');

test('T1: 标准 MD → 输出 contents 含 4 段 + key 与 ANCHORS 一致', () => {
  const r = runCli({
    args: ['--md', FIXTURE('sample-daily.md'), '--date', '2026-05-11'],
  });
  try {
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.contents.length, 4);
    assert.deepEqual(
      j.contents.map((c) => c.key),
      ['一、研发概览', '二、 需求推进', '三、今日产出', '四、今日总结']
    );
    assert.deepEqual(
      j.contents.map((c) => c.sort),
      ['0', '1', '2', '3']
    );
    for (const c of j.contents) {
      assert.equal(c.type, '1');
      assert.equal(c.content_type, 'markdown');
      assert.ok(c.content && c.content.length > 0, `empty content for ${c.key}`);
    }
  } finally {
    r.cleanup();
  }
});
