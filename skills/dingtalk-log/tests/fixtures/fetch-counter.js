'use strict';
// Reusable fetch mock controlled by DINGTALK_TEST_FETCH_PLAN env var.
// PLAN is a JSON array, each item:
//   { match: 'gettoken'|'create'|'savecontent'|'getbyname'|'listbyuserid'|'user-get',
//     body: <object>, status?: 200, delay?: 0, throw?: '<msg>' }
// Each fetch() consumes the first item; once exhausted, the last item is returned (steady-state).

const fs = require('node:fs');

const planRaw = process.env.DINGTALK_TEST_FETCH_PLAN || '[]';
const plan = JSON.parse(planRaw);
let idx = 0;

const counterFile = process.env.DINGTALK_TEST_FETCH_COUNTER;

function bumpCounter(tag) {
  if (!counterFile) return;
  const cur = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, 'utf-8')) : { calls: [] };
  cur.calls.push(tag);
  fs.writeFileSync(counterFile, JSON.stringify(cur));
}

module.exports = async function mockFetch(url, opts = {}) {
  const u = String(url);
  let tag = 'unknown';
  if (u.includes('/gettoken')) tag = 'gettoken';
  else if (u.includes('/topapi/report/create')) tag = 'create';
  else if (u.includes('/topapi/report/savecontent')) tag = 'savecontent';
  else if (u.includes('/topapi/report/template/getbyname')) tag = 'getbyname';
  else if (u.includes('/topapi/report/template/listbyuserid')) tag = 'listbyuserid';
  else if (u.includes('/topapi/v2/user/get')) tag = 'user-get';
  bumpCounter(tag);

  const step = plan[Math.min(idx, plan.length - 1)];
  idx++;
  if (step && step.delay) await new Promise((r) => setTimeout(r, step.delay));
  if (step && step.throw) throw new Error(step.throw);
  const body = (step && step.body) || { errcode: 0 };
  return {
    status: (step && step.status) || 200,
    ok: ((step && step.status) || 200) < 400,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};
