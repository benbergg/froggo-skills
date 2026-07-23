'use strict';
// V5 story-driven 采集单测:fetchVocOwnedExecutions + fetchStoryExecutionIds。
// 注入 mock 避免真实禅道流量。锁定 2026-07-24 phase2 查询方向反转设计
// (见知识库 20260724-体验罗盘日报-V5-设计文档)。

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZENTAO_BASE_URL = process.env.ZENTAO_BASE_URL || 'http://test.invalid';
process.env.ZENTAO_ACCOUNT = process.env.ZENTAO_ACCOUNT || 'test';
process.env.ZENTAO_PASSWORD = process.env.ZENTAO_PASSWORD || 'test';

const {
  fetchVocOwnedExecutions,
  fetchStoryExecutionIds,
  STATE,
} = require('../references/scripts/collect.js');

beforeEach(() => {
  STATE.skipped = [];
  STATE.apiCalls = 0;
});

test('fetchVocOwnedExecutions: 汇总白名单项目 exec + 记录 2023 的 doing 兜底集', async () => {
  const paginateFn = async (basePath) => {
    const map = {
      '/projects/3084/executions': [
        { id: 3456, status: 'doing' }, { id: 3455, status: 'closed' },
      ],
      '/projects/2023/executions': [
        { id: 2028, status: 'doing' }, { id: 1999, status: 'closed' },
      ],
    };
    return map[basePath] || [];
  };
  const { vocOwnedExecutionIds, looseBackfillExecs } =
    await fetchVocOwnedExecutions([3084, 2023], 2023, { paginateFn });

  assert.deepEqual([...vocOwnedExecutionIds].sort((a, b) => a - b), [1999, 2028, 3455, 3456]);
  // 兜底集只含 project 2023 里 status=doing 的 exec
  assert.deepEqual([...looseBackfillExecs], [2028]);
});

test('fetchVocOwnedExecutions: 非 2023 项目的 doing exec 不进兜底集', async () => {
  const paginateFn = async (basePath) => (
    basePath === '/projects/3084/executions' ? [{ id: 3456, status: 'doing' }] : []
  );
  const { looseBackfillExecs } = await fetchVocOwnedExecutions([3084], 2023, { paginateFn });
  assert.equal(looseBackfillExecs.size, 0, '3084 的 doing exec 不应进兜底集(仅 2023)');
});

function makeStoryFetch(storyExecMap, failIds = new Set()) {
  return async (url) => {
    const m = url.match(/^\/stories\/(\d+)$/);
    if (!m) return { ok: false, reason: `no-mock:${url}` };
    const sid = Number(m[1]);
    if (failIds.has(sid)) return { ok: false, reason: 'network-timeout' };
    return { ok: true, body: { id: sid, executions: storyExecMap[sid] || {} } };
  };
}

test('fetchStoryExecutionIds: 汇总各 story.executions 的 keys 为并集', async () => {
  const fetchFn = makeStoryFetch({
    22290: { 2028: {}, 3436: {} },  // VOC 日常 + 跨部门 aPaaS
    22197: { 2028: {} },
    22176: { 3247: {} },
  });
  const { ok, execIds } = await fetchStoryExecutionIds([22290, 22197, 22176], { fetchFn });
  assert.equal(ok, true);
  assert.deepEqual([...execIds].sort((a, b) => a - b), [2028, 3247, 3436]);
});

test('fetchStoryExecutionIds: story 无关联迭代(executions 空)不贡献 exec', async () => {
  const fetchFn = makeStoryFetch({ 22433: {}, 22290: { 2028: {} } });
  const { ok, execIds } = await fetchStoryExecutionIds([22433, 22290], { fetchFn });
  assert.equal(ok, true);
  assert.deepEqual([...execIds], [2028]);
});

test('fetchStoryExecutionIds: story 详情失败 → ok=false + STATE.skipped(critical)', async () => {
  const fetchFn = makeStoryFetch({ 22290: { 2028: {} } }, new Set([22176]));
  const { ok, execIds } = await fetchStoryExecutionIds([22290, 22176], { fetchFn });
  assert.equal(ok, false, 'story 详情失败必须 ok=false(触发 fatal)');
  assert.deepEqual([...execIds], [2028], '成功的 story 仍贡献其 exec');
  const sk = STATE.skipped.find((s) => s.storyId === 22176);
  assert.ok(sk, 'STATE.skipped 应记录失败的 story');
  assert.equal(sk.reason, 'network-timeout');
  // critical 判定:条目无 executions/execId 标记 → isNonCriticalSkip=false
  assert.equal(sk.executions, undefined);
  assert.equal(sk.execId, undefined);
});
