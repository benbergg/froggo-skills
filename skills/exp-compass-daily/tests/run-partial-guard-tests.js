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

// 2026-07-27:判据从"phase1 > 硬超时 30%"改为"剩余预算 < phase2 所需"。
// 原规则的前提(phase2 要遍历 87 个 execution)已被 V5 story-driven 消除,
// 固定比例变成误杀:phase1 317s/900s 数据完整、剩 583s 足够跑 phase2(实测
// 113s),旧规则却直接 exit 5。
test('phase1BudgetExceeded: 正常耗时(35s/900s)不触发', () => {
  assert.equal(phase1BudgetExceeded(35_397, 900_000), false);
});

test('phase1BudgetExceeded: 慢但预算仍够(317s/900s,剩 583s)不触发', () => {
  assert.equal(phase1BudgetExceeded(317_695, 900_000), false);
});

test('phase1BudgetExceeded: 预算真不够(700s/900s,剩 200s < 240s)触发', () => {
  assert.equal(phase1BudgetExceeded(700_000, 900_000), true);
});

test('phase1BudgetExceeded: 边界恰好等于所需不触发(严格小于才触发)', () => {
  assert.equal(phase1BudgetExceeded(660_000, 900_000, 240_000), false);
  assert.equal(phase1BudgetExceeded(660_001, 900_000, 240_000), true);
});
