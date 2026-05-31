'use strict';
// classifyTask 分类逻辑单测。
//
// 背景(2026-05-31):collect 把 status=wait 且本周未编辑(lastEditedDate 不在
// 本周、仅靠 assignedDate 进来)的"已派未动"任务也归入 tasks_progress,导致
// 周报"本周完成与推进的任务"段混入未开始任务。修正:wait 任务必须本周真
// 编辑过(lastEditedDate ∈ 本周)才算推进;指派(assignedDate)不算推进信号。
// doing/pause 维持 lastEditedDate || assignedDate。
//
// classifyTask(t, me, range) → { done, progress, nextWeek }
//   done 与 progress 互斥(完成优先);nextWeek 独立可叠加。

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const ME = 'qingwa';
// 本周 [05-25, 06-01),下周 [06-01, 06-08)
const RANGE = {
  wk_start: '2026-05-25T00:00:00+08:00',
  wk_end: '2026-06-01T00:00:00+08:00',
  next_s: '2026-06-01T00:00:00+08:00',
  next_e: '2026-06-08T00:00:00+08:00',
};

// 最小 task 工厂:只填判定相关字段
function T(over = {}) {
  return {
    id: 1, name: 'task', assignedTo: ME, finishedBy: null,
    status: 'wait', finishedDate: null, lastEditedDate: null,
    assignedDate: null, deadline: null, ...over,
  };
}

let classifyTask;
beforeEach(() => {
  delete require.cache[require.resolve('../references/scripts/collect-weekly.js')];
  ({ classifyTask } = require('../references/scripts/collect-weekly.js'));
});

test('wait 任务本周未编辑(仅本周指派)→ 不算推进', () => {
  // 这是 bug 场景:T44524/T44525,wait + lastEditedDate=null + assignedDate 在本周
  const t = T({ status: 'wait', lastEditedDate: null, assignedDate: '2026-05-27' });
  const r = classifyTask(t, ME, RANGE);
  assert.equal(r.progress, false, 'wait + 本周未编辑(只被指派)不应进入 tasks_progress');
});

test('wait 任务本周真编辑过 → 算推进', () => {
  const t = T({ status: 'wait', lastEditedDate: '2026-05-27', assignedDate: null });
  const r = classifyTask(t, ME, RANGE);
  assert.equal(r.progress, true, 'wait 但本周 lastEditedDate 在窗口内,确实碰过,应算推进');
});

test('doing 任务本周编辑过 → 算推进', () => {
  const t = T({ status: 'doing', lastEditedDate: '2026-05-29', assignedDate: null });
  const r = classifyTask(t, ME, RANGE);
  assert.equal(r.progress, true);
});

test('doing 任务本周未编辑但本周指派 → 仍算推进(doing 认 assignedDate)', () => {
  const t = T({ status: 'doing', lastEditedDate: null, assignedDate: '2026-05-26' });
  const r = classifyTask(t, ME, RANGE);
  assert.equal(r.progress, true, 'doing 维持旧逻辑:lastEditedDate || assignedDate');
});

test('被剔的 wait 任务若下周 deadline → 仍进入 tasks_next_week', () => {
  const t = T({ status: 'wait', lastEditedDate: null, assignedDate: '2026-05-27', deadline: '2026-06-03' });
  const r = classifyTask(t, ME, RANGE);
  assert.equal(r.progress, false, '本周不算推进');
  assert.equal(r.nextWeek, true, '下周 deadline 在 [next_s,next_e) → 应留在下周计划,不丢失');
});

test('完成任务(finishedBy=me 且本周完成)→ done,且与 progress 互斥', () => {
  const t = T({ status: 'done', finishedBy: ME, finishedDate: '2026-05-28', lastEditedDate: '2026-05-28' });
  const r = classifyTask(t, ME, RANGE);
  assert.equal(r.done, true);
  assert.equal(r.progress, false, '完成优先,不应同时计入推进');
});

test('非本人任务 → 三项全 false', () => {
  const t = T({ assignedTo: 'someone_else', finishedBy: 'someone_else',
    status: 'doing', lastEditedDate: '2026-05-29' });
  const r = classifyTask(t, ME, RANGE);
  assert.equal(r.done, false);
  assert.equal(r.progress, false);
  assert.equal(r.nextWeek, false);
});
