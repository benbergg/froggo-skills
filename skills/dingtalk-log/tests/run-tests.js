'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli } = require('./helpers');

test('sanity: CLI 启动并以 exit 1 退出(尚未实现任何子命令)', () => {
  const r = runCli({ args: [] });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not implemented/);
  } finally {
    r.cleanup();
  }
});
