'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli, FIXTURE } = require('./helpers');
const fs = require('node:fs');
const path = require('node:path');

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

test('T2: 第一段(研发概览)首行注入粗体汇报日期(不用 > 避免钉钉 HTML 实体 bug)', () => {
  const r = runCli({
    args: ['--md', FIXTURE('sample-daily.md'), '--date', '2026-05-11'],
  });
  try {
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const j = JSON.parse(r.stdout);
    const overview = j.contents[0].content;
    const lines = overview.split('\n');
    assert.equal(lines[0], '**📅 汇报日期 2026-05-11**', `actual line 0: ${lines[0]}`);
    assert.equal(lines[1], '', '应有空行分隔标题与正文');
    // 第三行起应该是正文(表格已转 list,故以 - 开头)
    assert.match(lines[2], /^📋 /, `actual line 2: ${lines[2]}`);
  } finally {
    r.cleanup();
  }
});

test('T2b: 其他 3 段不注入日期 quote', () => {
  const r = runCli({
    args: ['--md', FIXTURE('sample-daily.md'), '--date', '2026-05-11'],
  });
  try {
    const j = JSON.parse(r.stdout);
    for (let i = 1; i < 4; i++) {
      assert.doesNotMatch(j.contents[i].content, /汇报日期/, `section ${i} should not have date`);
    }
  } finally { r.cleanup(); }
});

test('T3: 研发概览段表格转 list,且不含 | 残留', () => {
  const r = runCli({
    args: ['--md', FIXTURE('sample-daily.md'), '--date', '2026-05-11'],
  });
  try {
    const j = JSON.parse(r.stdout);
    const overview = j.contents[0].content;
    assert.match(overview, /^📋 \*\*需求\*\*:进行中 7 \/ 今日新增 0 \/ 今日完成 0 \/ 待处理 3$/m);
    assert.match(overview, /^✅ \*\*任务\*\*:进行中 6 \/ 今日新增 10 \/ 今日完成 7 \/ 待处理 15$/m);
    assert.match(overview, /^🐞 \*\*BUG\*\*:进行中 15 \/ 今日新增 5 \/ 今日完成 7 \/ 待处理 15$/m);
    // 概览段不再含原表格的 | 字符
    assert.doesNotMatch(overview, /\| 需求 \|/);
    assert.doesNotMatch(overview, /\| 任务 \|/);
    assert.doesNotMatch(overview, /\| BUG \|/);
  } finally { r.cleanup(); }
});

test('T3b: 其他 3 段保留原 | 表格(若有)', () => {
  const r = runCli({
    args: ['--md', FIXTURE('sample-daily.md'), '--date', '2026-05-11'],
  });
  try {
    const j = JSON.parse(r.stdout);
    // 第二段「需求推进」含子任务表
    assert.match(j.contents[1].content, /\| T43911 \| 接口联调/);
  } finally { r.cleanup(); }
});

test('T4: 缺锚点 → exit 4 + stderr 列缺失锚点', () => {
  const r = runCli({
    args: ['--md', FIXTURE('sample-missing-anchor.md'), '--date', '2026-05-11'],
  });
  try {
    assert.equal(r.code, 4, `expected exit 4 got ${r.code}, stderr=${r.stderr}`);
    assert.match(r.stderr, /missing required H1 anchors.*三、今日产出/);
  } finally { r.cleanup(); }
});

test('T5: 概览段表格列数残缺 → 退化照搬原表格 + stderr WARN + exit 0', () => {
  const r = runCli({
    args: ['--md', FIXTURE('sample-bad-table.md'), '--date', '2026-05-11'],
  });
  try {
    assert.equal(r.code, 0, `expected exit 0 got ${r.code}, stderr=${r.stderr}`);
    assert.match(r.stderr, /WARN: overview table parse failed/);
    const j = JSON.parse(r.stdout);
    const overview = j.contents[0].content;
    // 退化后保留原表格行
    assert.match(overview, /\| 类型 \| 进行中 \|/);
    // 但粗体日期仍注入
    assert.match(overview, /^\*\*📅 汇报日期 2026-05-11\*\*/);
  } finally { r.cleanup(); }
});

test('T5b: 第一列变体 (需求 Story / 任务 Task / Bug) 仍解析为 emoji 行', () => {
  // 2026-05-13 regression: AI wrote '需求 Story', '任务 Task', 'Bug' instead
  // of '需求', '任务', 'BUG'. Old regex required exact match + BUG all-caps and
  // had a \b after the type word that never fires on CJK characters in JS regex.
  const r = runCli({
    args: ['--md', FIXTURE('sample-daily-variant-headers.md'), '--date', '2026-05-13'],
  });
  try {
    assert.equal(r.code, 0, `expected exit 0 got ${r.code}, stderr=${r.stderr}`);
    assert.doesNotMatch(r.stderr, /WARN: overview table parse failed/, 'should NOT degrade on variant headers');
    const j = JSON.parse(r.stdout);
    const overview = j.contents[0].content;
    assert.match(overview, /^📋 \*\*需求\*\*:进行中 4 \/ 今日新增 0 \/ 今日完成 0 \/ 待处理 3$/m);
    assert.match(overview, /^✅ \*\*任务\*\*:进行中 6 \/ 今日新增 1 \/ 今日完成 1 \/ 待处理 3$/m);
    assert.match(overview, /^🐞 \*\*BUG\*\*:进行中 8 \/ 今日新增 9 \/ 今日完成 4 \/ 待处理 13$/m);
    assert.doesNotMatch(overview, /\| (需求|任务|Bug) /, '概览段不应残留原表格 | 行');
  } finally { r.cleanup(); }
});

test('T6: --out 文件输出与 stdout 一致', () => {
  const r = runCli({
    args: ['--md', FIXTURE('sample-daily.md'), '--date', '2026-05-11'],
  });
  try {
    const stdoutJson = JSON.parse(r.stdout);

    const outPath = path.join(r.tmp, 'out.json');
    const r2 = runCli({
      args: ['--md', FIXTURE('sample-daily.md'), '--date', '2026-05-11', '--out', outPath],
    });
    try {
      assert.equal(r2.code, 0);
      assert.equal(r2.stdout, '', '--out 模式 stdout 应为空');
      const fileJson = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
      assert.deepEqual(fileJson, stdoutJson);
    } finally { r2.cleanup(); }
  } finally { r.cleanup(); }
});
