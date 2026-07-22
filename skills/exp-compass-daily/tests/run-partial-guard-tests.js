'use strict';
// Spec tests for the 2026-07-22 partial-data guard in collect.js:
//
//   1. finalizeOutput: skipped>0 时 JSON 落 `${out}.partial` 而非正式路径,
//      并删除正式路径旧文件 —— 物理断路,后续 Step 2+ 读不到正式 JSON
//      自然中止,不再依赖提示词约束(seq 83 事件:AI 无视 exit=2 用
//      partial 数据广播了错误日报)。
//   2. phase1BudgetExceeded: phase1 耗时超过硬超时 30% 时提前 FATAL,
//      避免禅道服务端抖动日 phase2 注定跑不完还白耗满 10 分钟
//      (2026-07-22 下午实证: phase1 323s vs 早上 35s)。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { finalizeOutput, phase1BudgetExceeded } = require('../references/scripts/collect.js');

function tmpOut() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-compass-partial-'));
  return path.join(dir, 'exp-compass-2026-07-22.json');
}

test('finalizeOutput: skipped=0 写正式路径', () => {
  const out = tmpOut();
  const target = finalizeOutput({ out, json: '{"ok":1}', skippedCount: 0 });
  assert.equal(target, out);
  assert.equal(fs.readFileSync(out, 'utf8'), '{"ok":1}');
  assert.equal(fs.existsSync(`${out}.partial`), false);
});

test('finalizeOutput: skipped>0 落 .partial,正式路径不产生文件', () => {
  const out = tmpOut();
  const target = finalizeOutput({ out, json: '{"partial":1}', skippedCount: 2 });
  assert.equal(target, `${out}.partial`);
  assert.equal(fs.readFileSync(`${out}.partial`, 'utf8'), '{"partial":1}');
  assert.equal(fs.existsSync(out), false);
});

test('finalizeOutput: skipped>0 删除正式路径旧文件(防过期 JSON 被 Step 2 误用)', () => {
  const out = tmpOut();
  fs.writeFileSync(out, '{"stale":"morning-run"}');
  finalizeOutput({ out, json: '{"partial":1}', skippedCount: 1 });
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(`${out}.partial`), true);
});

test('finalizeOutput: skipped>0 且正式路径不存在时不抛错', () => {
  const out = tmpOut();
  assert.doesNotThrow(() => finalizeOutput({ out, json: '{}', skippedCount: 1 }));
});

test('finalizeOutput: 输出文件权限 0600', () => {
  const out = tmpOut();
  finalizeOutput({ out, json: '{}', skippedCount: 1 });
  const mode = fs.statSync(`${out}.partial`).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('phase1BudgetExceeded: 正常耗时(35s/600s)不触发', () => {
  assert.equal(phase1BudgetExceeded(35_397, 600_000), false);
});

test('phase1BudgetExceeded: 抖动日(323s/600s)触发', () => {
  assert.equal(phase1BudgetExceeded(323_441, 600_000), true);
});

test('phase1BudgetExceeded: 恰好 30% 边界不触发(严格大于)', () => {
  assert.equal(phase1BudgetExceeded(180_000, 600_000), false);
  assert.equal(phase1BudgetExceeded(180_001, 600_000), true);
});
