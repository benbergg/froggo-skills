'use strict';
// dropProgressParentsOfDone 跨段父任务去重单测。
//
// 背景(2026-05-31):dedupParents 只做段内去重。当子任务本周完成(进
// tasks_done)、父任务本周未完成(doing,进 tasks_progress)时,父子分属
// 两段,段内去重碰不到,导致父任务在"完成与推进"段以【进行中】重复显示
// (子任务那行已带"父名/子名",父行冗余)。
//
// 修正:若某 progress 任务的 id 出现在任一 done 任务的 parent_id 中,则
// 从 tasks_progress 剔除。只清 progress,不动 tasks_next_week。
//
// dropProgressParentsOfDone(progress, done) → 过滤后的 progress 新数组

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

let dropProgressParentsOfDone;
beforeEach(() => {
  delete require.cache[require.resolve('../references/scripts/collect-weekly.js')];
  ({ dropProgressParentsOfDone } = require('../references/scripts/collect-weekly.js'));
});

test('progress 里的父任务,其子任务已在 done → 父被剔除', () => {
  // W22 真实场景:T44535(doing,父)在 progress,T44536(parent=44535)在 done
  const progress = [
    { id: 44535, parent_id: -1 },
    { id: 44523, parent_id: 44522 },
  ];
  const done = [{ id: 44536, parent_id: 44535 }];
  const r = dropProgressParentsOfDone(progress, done);
  assert.deepEqual(r.map((t) => t.id), [44523],
    'T44535 是已完成子任务 T44536 的父,应从 progress 剔除');
});

test('progress 里的任务,done 中无其子 → 保留', () => {
  const progress = [{ id: 44900, parent_id: -1 }];
  const done = [{ id: 44536, parent_id: 44535 }]; // 子属于别的父
  const r = dropProgressParentsOfDone(progress, done);
  assert.deepEqual(r.map((t) => t.id), [44900], '没有子任务在 done 的任务,应保留');
});

test('progress 普通子任务(非任何 done 的父)→ 保留', () => {
  const progress = [{ id: 44523, parent_id: 44522 }];
  const done = [{ id: 44536, parent_id: 44535 }];
  const r = dropProgressParentsOfDone(progress, done);
  assert.deepEqual(r.map((t) => t.id), [44523]);
});

test('done 为空 → progress 原样返回', () => {
  const progress = [{ id: 44535, parent_id: -1 }, { id: 44523, parent_id: 44522 }];
  const r = dropProgressParentsOfDone(progress, []);
  assert.deepEqual(r.map((t) => t.id), [44535, 44523]);
});

test('多个父都命中 → 全部剔除', () => {
  // W22:T44535、T44505 两个父都有子任务在 done
  const progress = [
    { id: 44535, parent_id: -1 },
    { id: 44505, parent_id: -1 },
    { id: 44523, parent_id: 44522 },
  ];
  const done = [
    { id: 44536, parent_id: 44535 },
    { id: 44506, parent_id: 44505 },
  ];
  const r = dropProgressParentsOfDone(progress, done);
  assert.deepEqual(r.map((t) => t.id), [44523], 'T44535/T44505 都应剔除,仅留 T44523');
});

test('不原地修改入参 progress', () => {
  const progress = [{ id: 44535, parent_id: -1 }];
  const done = [{ id: 44536, parent_id: 44535 }];
  dropProgressParentsOfDone(progress, done);
  assert.equal(progress.length, 1, '入参 progress 不应被原地修改');
});
