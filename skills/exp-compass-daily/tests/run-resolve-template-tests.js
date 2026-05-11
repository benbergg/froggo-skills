'use strict';
// BDD tests for resolve-template.js.
// Tests cover: stdin-mode parsing, exit-code mapping, cache file write,
// fields cross-check warning, and --bin integration via a fake stub.

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'references', 'scripts', 'resolve-template.js');
const FIXTURE = (name) => path.join(__dirname, 'fixtures', name);

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-template-test-'));
}

function runCli({ args = [], stdinFile = null, env = {} }) {
  const tmp = freshTmp();
  const fullEnv = { PATH: process.env.PATH, HOME: tmp, ...env };
  const opts = {
    env: fullEnv,
    encoding: 'utf-8',
    timeout: 10_000,
  };
  if (stdinFile) opts.input = fs.readFileSync(stdinFile, 'utf-8');
  const r = spawnSync('node', [CLI, ...args], opts);
  return {
    code: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

test('T1: stdin OK fixture → exit 0, stdout=template_id, stderr fields ok', () => {
  const r = runCli({
    args: ['--from-stdin', '--template-name', '体验罗盘日报'],
    stdinFile: FIXTURE('template-getbyname-ok.json'),
  });
  try {
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}, stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), '19dfc9ea0ad6bea06e79f444e4fa630e');
    assert.match(r.stderr, /fields[^\n]*ok|ok[^\n]*fields/i);
  } finally {
    r.cleanup();
  }
});

test('T2: fields mismatch → exit 0 + stderr WARN', () => {
  const r = runCli({
    args: ['--from-stdin', '--template-name', '体验罗盘日报'],
    stdinFile: FIXTURE('template-getbyname-fields-mismatch.json'),
  });
  try {
    assert.equal(r.code, 0, `expected exit 0 (warn-only), got ${r.code}, stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), '19dfc9ea0ad6bea06e79f444e4fa630e');
    assert.match(r.stderr, /WARN|mismatch/i);
    assert.match(r.stderr, /今日需求/);
  } finally {
    r.cleanup();
  }
});

test('T3: .result.id empty → exit 3', () => {
  const r = runCli({
    args: ['--from-stdin', '--template-name', '体验罗盘日报'],
    stdinFile: FIXTURE('template-getbyname-no-id.json'),
  });
  try {
    assert.equal(r.code, 3);
    assert.match(r.stderr, /template_id/i);
  } finally {
    r.cleanup();
  }
});

test('T4: errcode != 0 → exit 2', () => {
  const r = runCli({
    args: ['--from-stdin', '--template-name', '体验罗盘日报'],
    stdinFile: FIXTURE('template-getbyname-errcode.json'),
  });
  try {
    assert.equal(r.code, 2);
    assert.match(r.stderr, /60020|template not found|lookup/i);
  } finally {
    r.cleanup();
  }
});

test('T5: --cache writes JSON with template_id + default_received_convs', () => {
  const r = runCli({
    args: ['--from-stdin', '--template-name', '体验罗盘日报'],
    stdinFile: FIXTURE('template-getbyname-ok.json'),
  });
  try {
    assert.equal(r.code, 0);
    const cachePath = path.join(r.tmp, '.cache', 'exp-compass-daily', 'template.json');
    // Default cache location: $HOME/.cache/exp-compass-daily/template.json
    assert.ok(fs.existsSync(cachePath), `expected cache at ${cachePath}`);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    assert.equal(cache.template_id, '19dfc9ea0ad6bea06e79f444e4fa630e');
    assert.equal(cache.template_name, '体验罗盘日报');
    assert.ok(Array.isArray(cache.default_received_convs));
    assert.equal(cache.default_received_convs.length, 1);
    assert.equal(cache.default_received_convs[0].title, '体验罗盘-每日进度播报');
  } finally {
    r.cleanup();
  }
});

test('T6: invalid JSON on stdin → exit 2 with parse hint', () => {
  const tmp = freshTmp();
  try {
    const badFile = path.join(tmp, 'bad.json');
    fs.writeFileSync(badFile, '{not-json:');
    const r = runCli({
      args: ['--from-stdin', '--template-name', '体验罗盘日报'],
      stdinFile: badFile,
    });
    try {
      assert.equal(r.code, 2);
      assert.match(r.stderr, /parse|JSON|invalid/i);
    } finally {
      r.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T7: --bin integration with fake stub → spawn dingtalk-log, get template_id', () => {
  const r = runCli({
    args: [
      '--template-name', '体验罗盘日报',
      '--userid', 'u9',
      '--bin', FIXTURE('fake-dingtalk-ok.sh'),
    ],
  });
  try {
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}, stderr=${r.stderr}`);
    assert.equal(r.stdout.trim(), '19dfc9ea0ad6bea06e79f444e4fa630e');
  } finally {
    r.cleanup();
  }
});

test('T8: --bin pointing to nonexistent file → exit 2', () => {
  const r = runCli({
    args: [
      '--template-name', '体验罗盘日报',
      '--userid', 'u9',
      '--bin', '/nonexistent/bin/dingtalk-log.sh',
    ],
  });
  try {
    assert.equal(r.code, 2);
    assert.match(r.stderr, /spawn|not found|ENOENT|failed/i);
  } finally {
    r.cleanup();
  }
});

test('T9: missing --template-name → exit 1 (bad args)', () => {
  const r = runCli({
    args: ['--from-stdin'],
    stdinFile: FIXTURE('template-getbyname-ok.json'),
  });
  try {
    assert.equal(r.code, 1);
    assert.match(r.stderr, /template-name|required|usage/i);
  } finally {
    r.cleanup();
  }
});

test('T10: --cache <custom> overrides default location', () => {
  const tmp = freshTmp();
  try {
    const customCache = path.join(tmp, 'mytpl.json');
    const r = runCli({
      args: [
        '--from-stdin',
        '--template-name', '体验罗盘日报',
        '--cache', customCache,
      ],
      stdinFile: FIXTURE('template-getbyname-ok.json'),
    });
    try {
      assert.equal(r.code, 0);
      assert.ok(fs.existsSync(customCache));
      const cache = JSON.parse(fs.readFileSync(customCache, 'utf-8'));
      assert.equal(cache.template_id, '19dfc9ea0ad6bea06e79f444e4fa630e');
    } finally {
      r.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
