'use strict';
// Happy-path fixture for the E2E suite.
//
// Shape: one product (id=95 "VOC") with one VOC-owned project (id=3084)
// holding two doing executions (1001, 1002). Tasks are spread so the
// expected summary touches every bucket — in_progress / today_new /
// today_done / todo — exercising the field-derivation pipeline end to
// end.
//
// All dates are pinned relative to the input `date`. Default 2026-05-20
// keeps the assertions deterministic regardless of when the test runs.

const TEST_DATE = '2026-05-20';

function happyScenario(date = TEST_DATE) {
  const yesterday = '2026-05-19';
  const fiveDaysAgo = '2026-05-15';
  const tenDaysAgo = '2026-05-10';
  const twoDaysAgo = '2026-05-18';

  // ---- tasks per execution -----------------------------------------------
  // exec 1001
  const T501 = { id: 501, name: 'T501 opened today', status: 'doing', openedDate: `${date} 09:00:00`, finishedDate: null, deadline: null, story: 100, parent: 0, assignedTo: 'qingwa', lastEditedDate: `${date} 10:00:00`, execution: 1001 };
  const T502 = { id: 502, name: 'T502 done today', status: 'closed', openedDate: `${tenDaysAgo} 10:00:00`, finishedDate: `${date} 11:00:00`, deadline: null, story: 100, parent: 0, assignedTo: 'qingwa', lastEditedDate: `${date} 11:00:00`, execution: 1001 };
  const T503 = { id: 503, name: 'T503 in flight', status: 'doing', openedDate: `${fiveDaysAgo} 14:00:00`, finishedDate: null, deadline: null, story: 100, parent: 0, assignedTo: 'qingwa', lastEditedDate: `${fiveDaysAgo} 16:00:00`, execution: 1001 };
  // exec 1002
  const T504 = { id: 504, name: 'T504 wait', status: 'wait', openedDate: `${twoDaysAgo} 12:00:00`, finishedDate: null, deadline: null, story: 200, parent: 0, assignedTo: 'qingwa', lastEditedDate: `${twoDaysAgo} 12:00:00`, execution: 1002 };
  const T505 = { id: 505, name: 'T505 in flight', status: 'doing', openedDate: `${yesterday} 09:00:00`, finishedDate: null, deadline: null, story: 200, parent: 0, assignedTo: 'qingwa', lastEditedDate: `${date} 14:00:00`, execution: 1002 };

  // ---- stories -----------------------------------------------------------
  const S100 = { id: 100, title: 'S100 developing', stage: 'developing', status: 'active', openedDate: `${tenDaysAgo} 09:00:00`, closedDate: null, openedBy: 'qingwa', assignedTo: 'qingwa' };
  const S200 = { id: 200, title: 'S200 wait', stage: 'wait', status: 'active', openedDate: `${twoDaysAgo} 09:00:00`, closedDate: null, openedBy: 'qingwa', assignedTo: 'qingwa' };
  const S300 = { id: 300, title: 'S300 closed today', stage: 'closed', status: 'closed', openedDate: `${tenDaysAgo} 09:00:00`, closedDate: `${date} 15:00:00`, openedBy: 'qingwa', assignedTo: 'qingwa' };

  // ---- bugs --------------------------------------------------------------
  const B901 = { id: 901, title: 'B901 active', status: 'active', openedDate: `${fiveDaysAgo} 09:00:00`, closedDate: null, resolvedDate: null, openedBy: 'qingwa', assignedTo: 'qingwa' };
  const B902 = { id: 902, title: 'B902 resolved', status: 'resolved', openedDate: `${yesterday} 09:00:00`, closedDate: null, resolvedDate: `${date} 10:00:00`, openedBy: 'qingwa', assignedTo: 'qingwa' };
  const B903 = { id: 903, title: 'B903 closed today', status: 'closed', openedDate: `${tenDaysAgo} 09:00:00`, closedDate: `${date} 14:00:00`, resolvedDate: `${date} 12:00:00`, openedBy: 'qingwa', assignedTo: 'qingwa' };

  // ---- routes ------------------------------------------------------------
  // Build per-exec routes once; the three desc queries differ only by sort
  // order, and on this mock the same task set is returned regardless (the
  // server-side desc sort is what collect.js relies on for early-exit, but
  // the union dedup makes the sort within a single response a no-op).
  const execTasks = {
    1001: [T501, T502, T503],
    1002: [T504, T505],
  };

  const routes = {};
  routes['GET /users?limit=100&page=1'] = { users: [{ account: 'qingwa', realname: '青蛙' }], total: 1 };
  routes['GET /products/95'] = { id: 95, name: 'VOC' };
  // active stories (no status filter) — Zentao instance returns activestory only
  routes['GET /products/95/stories?limit=100&page=1'] = { stories: [S100, S200], total: 2 };
  // closed-today via order=closedDate_desc early-exit
  routes['GET /products/95/stories?limit=100&order=closedDate_desc&page=1&status=closedstory'] = {
    stories: [S300, { ...S100, closedDate: null }], // null at tail triggers break
    total: 2,
  };
  // unclosed bugs
  routes['GET /products/95/bugs?limit=100&page=1&status=unclosed'] = { bugs: [B901, B902], total: 2 };
  // closed-today bugs via order=closedDate_desc early-exit (null at tail breaks)
  routes['GET /products/95/bugs?limit=100&order=closedDate_desc&page=1&status=all'] = {
    bugs: [B903, { ...B901, closedDate: null }], // null at tail
    total: 2,
  };
  // projects under product
  routes['GET /products/95/projects'] = { projects: [{ id: 3084, name: 'VOC Project' }] };
  // executions under project — only doing/wait per Zentao default
  routes['GET /projects/3084/executions'] = {
    executions: [
      { id: 1001, name: 'Sprint A', status: 'doing', lastEditedDate: `${date} 14:00:00`, products: [95] },
      { id: 1002, name: 'Sprint B', status: 'doing', lastEditedDate: `${date} 14:00:00`, products: [95] },
    ],
  };
  // per-exec scoped tasks (3 desc queries each, all returning the same set)
  for (const [execId, tasks] of Object.entries(execTasks)) {
    for (const order of ['openedDate_desc', 'finishedDate_desc', 'lastEditedDate_desc']) {
      const key = `GET /executions/${execId}/tasks?limit=100&order=${order}&page=1`;
      routes[key] = { tasks, total: tasks.length };
    }
  }

  return {
    routes,
    fixtures: { T501, T502, T503, T504, T505, S100, S200, S300, B901, B902, B903 },
  };
}

const HAPPY_EXPECTED_SUMMARY = {
  story: { in_progress: 1, today_new: 0, today_done: 1, todo: 1 },
  // task in_progress = T501, T503, T505 (status=doing)
  // task today_new = T501 (openedDate=today)
  // task today_done = T502 (finishedDate=today, not aggregate parent)
  // task todo = T504 (status=wait)
  task: { in_progress: 3, today_new: 1, today_done: 1, todo: 1 },
  // bug in_progress = B902 (resolved)
  // bug today_new = 0
  // bug today_done = B903 (closedDate=today)
  // bug todo = B901 (active)
  bug: { in_progress: 1, today_new: 0, today_done: 1, todo: 1 },
};

module.exports = { happyScenario, TEST_DATE, HAPPY_EXPECTED_SUMMARY };
