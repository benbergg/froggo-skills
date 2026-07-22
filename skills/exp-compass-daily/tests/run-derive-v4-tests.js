'use strict';
// V4 派生字段单元测试(设计文档 [[20260722-体验罗盘日报-V4-设计文档]] §6)。
//
// 覆盖:
//   - task.overdue_days
//   - task.display_handler 流转陷阱回归(done 任务 assignedTo 被禅道指派回创建人)
//   - bug.resolved_age_days / display_title / display_reporter
//   - story.is_active / stale_days / last_activity_date / is_today_tested
//   - story.is_today_done 拓宽(released/verified + lastEditedDate)
//   - buildSummary story.active/stale + bug 行重映射
//   - inScopeStory released/verified 当日编辑纳入

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const {
  deriveTask, deriveBug, deriveStory, buildSummary, inScopeStory,
} = require('../references/scripts/collect.js');

const DATE = '2026-07-21';

const T = (fields = {}) => ({
  id: 1, name: 't', type: 'devel', story: 0, execution: 0, parent: -1,
  status: 'wait', assignedTo: null, finishedBy: null, openedBy: null,
  deadline: null, consumed: 0, left: 0, openedDate: null, finishedDate: null,
  ...fields,
});

const B = (fields = {}) => ({
  id: 1, title: 'bug', status: 'active', severity: 3,
  openedBy: null, openedDate: null, resolvedBy: null, resolvedDate: null,
  closedBy: null, closedDate: null, assignedTo: null,
  ...fields,
});

const S = (fields = {}) => ({
  id: 1, title: 's', stage: 'developing',
  openedBy: null, openedDate: null, closedBy: null, closedDate: null,
  lastEditedDate: null,
  ...fields,
});

// ---- task.overdue_days ---------------------------------------------------

test('overdue_days: doing 任务 deadline 7-09 → 12 天', () => {
  const t = deriveTask(T({ status: 'doing', deadline: '2026-07-09' }), DATE);
  assert.equal(t.is_overdue, true);
  assert.equal(t.overdue_days, 12);
});

test('overdue_days: done 任务不算逾期 → 0', () => {
  const t = deriveTask(T({ status: 'done', deadline: '2026-07-09', finishedBy: 'x' }), DATE);
  assert.equal(t.is_overdue, false);
  assert.equal(t.overdue_days, 0);
});

test('overdue_days: 无 deadline → 0', () => {
  const t = deriveTask(T({ status: 'doing' }), DATE);
  assert.equal(t.overdue_days, 0);
});

// ---- 禅道流转陷阱回归 ----------------------------------------------------

test('display_handler: done 任务 assignedTo 已流转回创建人,必须取 finishedBy', () => {
  // 实证 T45717: openedBy=虹猫, assignedTo=虹猫(流转回), finishedBy=黄虎
  const t = deriveTask(T({
    status: 'done', openedBy: '虹猫', assignedTo: '虹猫', finishedBy: '黄虎',
  }), DATE);
  assert.equal(t.display_handler, '黄虎');
});

test('display_handler: wait 任务取 assignedTo(将执行的人)', () => {
  const t = deriveTask(T({ status: 'wait', openedBy: '虹猫', assignedTo: '青蛙' }), DATE);
  assert.equal(t.display_handler, '青蛙');
});

// ---- bug.resolved_age_days ----------------------------------------------

test('resolved_age_days: resolved 6-26 → 25 天', () => {
  const b = deriveBug(B({ status: 'resolved', resolvedBy: '乔巴', resolvedDate: '2026-06-26T05:34:33Z' }), DATE);
  assert.equal(b.resolved_age_days, 25);
});

test('resolved_age_days: active bug → 0', () => {
  const b = deriveBug(B({ status: 'active' }), DATE);
  assert.equal(b.resolved_age_days, 0);
});

// ---- bug.display_title ---------------------------------------------------

test('display_title: 去开头【日期】前缀并 trim', () => {
  const b = deriveBug(B({ title: '【20260720】客户已经充值voc拉取额度' }), DATE);
  assert.equal(b.display_title, '客户已经充值voc拉取额度');
});

test('display_title: 超 40 字截断加 …', () => {
  const long = 'あ'.repeat(50);
  const b = deriveBug(B({ title: long }), DATE);
  assert.equal(b.display_title, 'あ'.repeat(40) + '…');
});

test('display_title: 普通短标题原样保留', () => {
  const b = deriveBug(B({ title: '评价没有拉取到班牛' }), DATE);
  assert.equal(b.display_title, '评价没有拉取到班牛');
});

// ---- bug.display_reporter ------------------------------------------------

test('display_reporter: 机器人录入且有 assignedTo → "{assignedTo}·机器人录入"', () => {
  const b = deriveBug(B({ openedBy: 'bug录入机器人', assignedTo: '黄虎' }), DATE);
  assert.equal(b.display_reporter, '黄虎·机器人录入');
});

test('display_reporter: 机器人录入且无 assignedTo → 回退 openedBy', () => {
  const b = deriveBug(B({ openedBy: 'bug录入机器人' }), DATE);
  assert.equal(b.display_reporter, 'bug录入机器人');
});

test('display_reporter: 普通创建人原样', () => {
  const b = deriveBug(B({ openedBy: '青蛙', assignedTo: '黄虎' }), DATE);
  assert.equal(b.display_reporter, '青蛙');
});

// ---- story.is_active -----------------------------------------------------

test('is_active: developing 恒为 true(即使无任务)', () => {
  const s = deriveStory(S({ stage: 'developing' }), [], DATE);
  assert.equal(s.is_active, true);
});

test('is_active: developed 全 done 无动态 → false(滞留)', () => {
  const tasks = [deriveTask(T({ status: 'done', finishedBy: '小豆', finishedDate: '2026-06-18T10:00:00Z' }), DATE)];
  const s = deriveStory(S({ stage: 'developed' }), tasks, DATE);
  assert.equal(s.is_active, false);
});

test('is_active: developed 含 doing 任务 → true', () => {
  const tasks = [deriveTask(T({ status: 'doing' }), DATE)];
  const s = deriveStory(S({ stage: 'developed' }), tasks, DATE);
  assert.equal(s.is_active, true);
});

test('is_active: developed 含逾期任务 → true', () => {
  const tasks = [deriveTask(T({ status: 'wait', deadline: '2026-07-09' }), DATE)];
  const s = deriveStory(S({ stage: 'developed' }), tasks, DATE);
  assert.equal(s.is_active, true);
});

test('is_active: tested 含当日完成任务 → true', () => {
  const tasks = [deriveTask(T({ status: 'done', finishedBy: '黄虎', finishedDate: '2026-07-21T09:00:00Z' }), DATE)];
  const s = deriveStory(S({ stage: 'tested' }), tasks, DATE);
  assert.equal(s.is_active, true);
});

test('is_active: 非进行中 stage → false', () => {
  const s = deriveStory(S({ stage: 'wait' }), [], DATE);
  assert.equal(s.is_active, false);
});

// ---- story.stale_days / last_activity_date -------------------------------

test('stale_days: 最后任务动态 6-18 → 33 天', () => {
  const tasks = [deriveTask(T({
    status: 'done', finishedBy: '小豆',
    openedDate: '2026-06-09T08:00:00Z', finishedDate: '2026-06-18T10:00:00Z',
  }), DATE)];
  const s = deriveStory(S({ stage: 'developed', openedDate: '2026-06-09T08:00:00Z' }), tasks, DATE);
  assert.equal(s.stale_days, 33);
  assert.equal(s.last_activity_date, '2026-06-18T10:00:00Z');
});

test('stale_days: 无任务时回退 story.openedDate', () => {
  const s = deriveStory(S({ stage: 'developed', openedDate: '2026-05-08T08:00:00Z' }), [], DATE);
  assert.equal(s.stale_days, 74);
  assert.equal(s.last_activity_date, '2026-05-08T08:00:00Z');
});

test('stale_days: 当日有动态 → 0,不为负', () => {
  const tasks = [deriveTask(T({ status: 'done', finishedBy: 'x', finishedDate: '2026-07-21T09:00:00Z' }), DATE)];
  const s = deriveStory(S({ stage: 'tested' }), tasks, DATE);
  assert.equal(s.stale_days, 0);
});

// ---- story.is_today_tested -----------------------------------------------

test('is_today_tested: tested + 测试任务当日完成 → true', () => {
  const tasks = [deriveTask(T({ type: 'test', status: 'done', finishedBy: '黄虎', finishedDate: '2026-07-21T09:00:00Z' }), DATE)];
  const s = deriveStory(S({ stage: 'tested' }), tasks, DATE);
  assert.equal(s.is_today_tested, true);
});

test('is_today_tested: tested 但测试任务非当日完成 → false', () => {
  const tasks = [deriveTask(T({ type: 'test', status: 'done', finishedBy: '黄虎', finishedDate: '2026-07-18T09:00:00Z' }), DATE)];
  const s = deriveStory(S({ stage: 'tested' }), tasks, DATE);
  assert.equal(s.is_today_tested, false);
});

test('is_today_tested: developed + 当日完成的 devel 任务 → false(非 test 类型)', () => {
  const tasks = [deriveTask(T({ type: 'devel', status: 'done', finishedBy: 'x', finishedDate: '2026-07-21T09:00:00Z' }), DATE)];
  const s = deriveStory(S({ stage: 'developed' }), tasks, DATE);
  assert.equal(s.is_today_tested, false);
});

// ---- story.is_today_done 拓宽(E4) ---------------------------------------

test('is_today_done: closed + closedDate 当天 → true(原行为保留)', () => {
  const s = deriveStory(S({ stage: 'closed', closedDate: '2026-07-21T10:00:00Z' }), [], DATE);
  assert.equal(s.is_today_done, true);
});

test('is_today_done: released + lastEditedDate 当天(无 closedDate) → true(V4 拓宽)', () => {
  const s = deriveStory(S({ stage: 'released', lastEditedDate: '2026-07-21T10:00:00Z' }), [], DATE);
  assert.equal(s.is_today_done, true);
});

test('is_today_done: tested 不算完成 → false', () => {
  const s = deriveStory(S({ stage: 'tested', lastEditedDate: '2026-07-21T10:00:00Z' }), [], DATE);
  assert.equal(s.is_today_done, false);
});

test('is_today_done: closed 但 closedDate 非当天 → false', () => {
  const s = deriveStory(S({ stage: 'closed', closedDate: '2026-07-18T10:00:00Z' }), [], DATE);
  assert.equal(s.is_today_done, false);
});

// ---- buildSummary V4 -----------------------------------------------------

test('summary.story: active/stale 拆分且 active+stale == in_progress', () => {
  const mk = (stage, tasks) => deriveStory(S({ id: Math.random(), stage }), tasks, DATE);
  const doingTask = [deriveTask(T({ status: 'doing' }), DATE)];
  const doneTask = [deriveTask(T({ status: 'done', finishedBy: 'x', finishedDate: '2026-06-18T10:00:00Z' }), DATE)];
  const stories = [
    mk('developing', doingTask),   // active
    mk('developed', doneTask),     // stale
    mk('developed', doingTask),    // active
    mk('wait', []),                // todo
  ];
  const sum = buildSummary(stories, [], []);
  assert.equal(sum.story.active, 2);
  assert.equal(sum.story.stale, 1);
  assert.equal(sum.story.in_progress, 3);
  assert.equal(sum.story.todo, 1);
});

test('summary.bug: V4 重映射 in_progress=active(修复中), todo=resolved(待验)', () => {
  const bugs = [
    deriveBug(B({ status: 'active' }), DATE),
    deriveBug(B({ status: 'active' }), DATE),
    deriveBug(B({ status: 'resolved', resolvedDate: '2026-07-17T00:00:00Z' }), DATE),
  ];
  const sum = buildSummary([], [], bugs);
  assert.equal(sum.bug.in_progress, 2, 'in_progress 应为 active 数');
  assert.equal(sum.bug.todo, 1, 'todo 应为 resolved 数');
});

// ---- inScopeStory 拓宽 ---------------------------------------------------

test('inScopeStory: released + lastEditedDate 当天 → 纳入', () => {
  assert.equal(inScopeStory(S({ stage: 'released', lastEditedDate: '2026-07-21 10:00:00' }), DATE), true);
});

test('inScopeStory: released 非当天编辑 → 排除', () => {
  assert.equal(inScopeStory(S({ stage: 'released', lastEditedDate: '2026-07-01 10:00:00' }), DATE), false);
});

test('display_reporter: assignedTo 也是机器人 → 回退 openedBy(2026-07-22 回放实证 B56899)', () => {
  const b = deriveBug(B({ openedBy: 'bug录入机器人', assignedTo: 'bug录入机器人' }), DATE);
  assert.equal(b.display_reporter, 'bug录入机器人');
});

// ---- progress 工时盲区修复(2026-07-22 实证 S22290:5 任务 1 完成显示 100%) ----

test('progress: 未完成任务缺工时(consumed+left=0) → 降级任务计数口径', () => {
  // S22290 实况:done 6/0 + doing 6/0 + 3× wait 0/0 → 旧算法 12/12=100%,应为 1/5=20%
  const tasks = [
    deriveTask(T({ id: 1, status: 'done', finishedBy: 'x', consumed: 6, left: 0 }), DATE),
    deriveTask(T({ id: 2, status: 'doing', consumed: 6, left: 0 }), DATE),
    deriveTask(T({ id: 3, status: 'wait' }), DATE),
    deriveTask(T({ id: 4, status: 'wait' }), DATE),
    deriveTask(T({ id: 5, status: 'wait' }), DATE),
  ];
  const s = deriveStory(S({ stage: 'developing' }), tasks, DATE);
  assert.equal(s.progress_pct, 20);
  assert.equal(s.progress_source, '任务');
});

test('progress: 未完成任务都有工时数据 → 维持工时口径', () => {
  const tasks = [
    deriveTask(T({ id: 1, status: 'done', finishedBy: 'x', consumed: 6, left: 0 }), DATE),
    deriveTask(T({ id: 2, status: 'doing', consumed: 2, left: 6 }), DATE),
  ];
  const s = deriveStory(S({ stage: 'developing' }), tasks, DATE);
  assert.equal(s.progress_source, '工时');
  assert.equal(s.progress_pct, 57); // 8/(8+6)
});

test('progress: 全部完成但无工时 → 任务计数 100%', () => {
  const tasks = [
    deriveTask(T({ id: 1, status: 'done', finishedBy: 'x' }), DATE),
    deriveTask(T({ id: 2, status: 'done', finishedBy: 'y' }), DATE),
  ];
  const s = deriveStory(S({ stage: 'developed' }), tasks, DATE);
  assert.equal(s.progress_pct, 100);
  assert.equal(s.progress_source, '任务');
});

test('progress: 无任务 → 阶段估值回退不变', () => {
  const s = deriveStory(S({ stage: 'developed' }), [], DATE);
  assert.equal(s.progress_pct, 80);
  assert.equal(s.progress_source, '阶段');
});

test('bug.url: 由 ZENTAO_BASE_URL 去 api 尾巴派生跟踪链接', () => {
  const base = String(process.env.ZENTAO_BASE_URL).replace(/\/api\.php.*$/, '');
  const b = deriveBug(B({ id: 57142 }), DATE);
  assert.equal(b.url, `${base}/bug-view-57142.html`);
  assert.doesNotMatch(b.url, /api\.php/);
});
