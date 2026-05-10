#!/usr/bin/env node
// weekly-report / collect-weekly.js
// Pulls Zentao tasks/bugs scoped to the current user for an ISO week, derives
// helper fields (display_path, type_cn, wk_role, summary, bug_root_cause) and
// writes a single normalized JSON consumable by the AI writing layer.
//
// Usage:
//   node collect-weekly.js [--week 2026-W19] [--out /tmp/weekly-{WK_NUM}.json]
//
// Required env: ZENTAO_BASE_URL, ZENTAO_ACCOUNT, ZENTAO_PASSWORD
// Optional env: ZENTAO_ME, ZENTAO_CACHE_DIR, XDG_CACHE_HOME, WEEKLY_API_BUDGET
//
// Token bridge: reads $ZT_CACHE/token.json maintained by zentao-api skill;
// on 401 spawns `bash -c 'source zt-functions.sh; zt_acquire_token'` to refresh.
// Never re-implements /tokens API.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- env autoloading ----------------------------------------------------
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf-8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
for (const f of [
  path.join(process.env.HOME || '', '.openclaw/.env'),
  path.join(process.env.HOME || '', '.zentao.env'),
]) {
  loadEnvFile(f);
}

// ---- constants ----------------------------------------------------------

const STATUS_CN = {
  wait: '未开始', doing: '进行中', done: '已完成', pause: '暂停',
  blocked: '阻塞', cancel: '已取消', closed: '已关闭',
};

const BUG_STATUS_CN = {
  active: '激活', resolved: '已解决', closed: '已关闭',
};

const BUG_TYPE_CN = {
  codeerror: '代码缺陷',
  config: '配置问题', install: '配置问题',
  designdefect: '需求缺失',
  others: '非缺陷类', standard: '非缺陷类', performance: '非缺陷类',
  security: '非缺陷类', automation: '非缺陷类',
};
const BUG_ROOT_CAUSE_KEYS = ['代码缺陷', '配置问题', '需求缺失', '非缺陷类'];

// ---- arg parsing --------------------------------------------------------

function parseArgs(argv) {
  const out = { week: null, out: null, allowPartial: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--week') { out.week = v; i++; }
    else if (k === '--out') { out.out = v; i++; }
    else if (k === '--allow-partial') { out.allowPartial = true; }
  }
  if (process.env.WEEKLY_ALLOW_PARTIAL === '1') out.allowPartial = true;
  if (!out.week) out.week = isoWeekOf(new Date());
  if (!out.out) out.out = `/tmp/weekly-${out.week}.json`;
  return out;
}

// ---- ISO week math ------------------------------------------------------

// ISO 8601 week: Monday-start, week 01 contains the year's first Thursday.
// Returns "GGGG-WVV" for a Date.
function isoWeekOf(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum); // Mon of this ISO week
  const thu = new Date(t);
  thu.setUTCDate(t.getUTCDate() + 3); // Thu of this ISO week → determines ISO year
  const isoYear = thu.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const w1Mon = new Date(jan4);
  w1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
  const wk = Math.round((t - w1Mon) / (7 * 86_400_000)) + 1;
  return `${isoYear}-W${String(wk).padStart(2, '0')}`;
}

// Returns { wk_start, wk_end, next_s, next_e } as ISO-8601 strings in
// Asia/Shanghai (+0800). wk_start = Monday 00:00, wk_end = next Monday 00:00.
function weekRange(weekStr) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekStr);
  if (!m) throw new Error(`bad week format: ${weekStr} (want GGGG-WVV)`);
  const year = Number(m[1]);
  const wk = Number(m[2]);
  // Compute Monday of ISO week 'wk' of year 'year'.
  // Jan 4th is always in ISO week 1; back up to its Monday → that's W1 Monday.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const w1Mon = new Date(jan4);
  w1Mon.setUTCDate(jan4.getUTCDate() - jan4Day);
  const monThisWeek = new Date(w1Mon);
  monThisWeek.setUTCDate(w1Mon.getUTCDate() + (wk - 1) * 7);
  // Format as +08:00 (week boundaries are local-zone semantics).
  const fmt = (d) => {
    const utcMs = d.getTime();
    // Shift to +08:00: add 8h to UTC then format Z as +08:00.
    const local = new Date(utcMs + 8 * 3600_000);
    return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}T00:00:00+08:00`;
  };
  // monThisWeek currently represents UTC midnight; we want +08:00 midnight.
  // Subtract 8h so when we re-format with +08:00 it lands on the Monday 00:00 local.
  const monLocalMid = new Date(monThisWeek.getTime() - 8 * 3600_000);
  const sundayEndLocalMid = new Date(monLocalMid.getTime() + 7 * 86_400_000);
  const nextSundayEndLocalMid = new Date(monLocalMid.getTime() + 14 * 86_400_000);
  return {
    wk_start: fmt(monLocalMid),
    wk_end: fmt(sundayEndLocalMid),
    next_s: fmt(sundayEndLocalMid),
    next_e: fmt(nextSundayEndLocalMid),
  };
}

// "2026-05-08" → true if within [wk_start_iso, wk_end_iso) by date string compare.
function dateInRange(dateStr, startIso, endIso) {
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  if (!d) return false;
  const s = startIso.slice(0, 10);
  const e = endIso.slice(0, 10);
  return d >= s && d < e;
}

// ---- env / paths --------------------------------------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FATAL: env ${name} is required`);
    process.exit(1);
  }
  return v;
}

function ztCacheDir() {
  if (process.env.ZENTAO_CACHE_DIR) return process.env.ZENTAO_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, 'zentao');
  return path.join(process.env.HOME, '.cache', 'zentao');
}

function readTokenFile() {
  const p = path.join(ztCacheDir(), 'token.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return j.token || null;
  } catch (_) {
    return null;
  }
}

function refreshTokenViaBash() {
  const here = path.resolve(__dirname);
  const zentaoFn = path.resolve(here, '..', '..', '..', 'zentao-api', 'scripts', 'zt-functions.sh');
  if (!fs.existsSync(zentaoFn)) {
    throw new Error(`zt-functions.sh not found at ${zentaoFn}`);
  }
  const r = spawnSync('bash', ['-c', `source "${zentaoFn}" && zt_init && zt_acquire_token >/dev/null`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  if (r.status !== 0) {
    throw new Error(`zt_acquire_token failed: ${(r.stderr || '').toString().slice(0, 200)}`);
  }
}

// ---- HTTP layer ---------------------------------------------------------

const STATE = {
  baseUrl: '',
  token: '',
  apiCalls: 0,
  // Weekly scope is much wider than daily: a typical user view may include
  // 100+ products and 200+ sprints, each requiring 1-N paginated calls.
  // 2000 covers ~150 products × (bugs/all + bugs/active default) + ~250
  // sprints × tasks + small overhead. Override via WEEKLY_API_BUDGET.
  budget: parseInt(process.env.WEEKLY_API_BUDGET || '2000', 10),
  budgetExceeded: false,
  skipped: [],
};

function sanitizeMessage(s) {
  return String(s).replace(/Token:\s*\S+/gi, 'Token: ***').replace(/token=\S+/gi, 'token=***');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ztFetch(pathAndQuery, { allowRefresh = true } = {}) {
  if (STATE.apiCalls >= STATE.budget) {
    STATE.budgetExceeded = true;
    return { ok: false, status: 0, body: null, reason: 'budget' };
  }
  STATE.apiCalls++;

  const url = STATE.baseUrl + pathAndQuery;
  const backoff = [1000, 2000, 4000, 8000];
  let lastErr = null;

  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Token': STATE.token, 'Content-Type': 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.status === 401 && allowRefresh) {
        try {
          refreshTokenViaBash();
          const fresh = readTokenFile();
          if (!fresh) throw new Error('token cache empty after refresh');
          STATE.token = fresh;
          return ztFetch(pathAndQuery, { allowRefresh: false });
        } catch (e) {
          throw new Error(`401 refresh failed: ${sanitizeMessage(e.message)}`);
        }
      }

      if (res.status === 429 || res.status === 503 || (res.status >= 500 && res.status < 600)) {
        if (attempt < backoff.length) {
          await sleep(backoff[attempt]);
          continue;
        }
        return { ok: false, status: res.status, body: null, reason: 'rate-limit' };
      }

      if (!res.ok) {
        return { ok: false, status: res.status, body: await res.text(), reason: 'http' };
      }

      const text = (await res.text()).replace(/[\x00-\x1F]/g, (c) => (c === '\n' || c === '\t' ? c : ''));
      try {
        return { ok: true, status: 200, body: JSON.parse(text) };
      } catch (e) {
        return { ok: false, status: 200, body: text.slice(0, 200), reason: 'json-parse' };
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const isNetwork = e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.name === 'AbortError';
      if (isNetwork && attempt < backoff.length) {
        await sleep(backoff[attempt]);
        continue;
      }
      return { ok: false, status: 0, body: null, reason: sanitizeMessage(e.message) };
    }
  }
  return { ok: false, status: 0, body: null, reason: lastErr ? sanitizeMessage(lastErr.message) : 'unknown' };
}

async function ztPaginate(basePath, listKey) {
  const sep = basePath.includes('?') ? '&' : '?';
  const limit = 500;
  const sanitizedPath = basePath.replace(/\/products\/\d+|\/projects\/\d+|\/executions\/\d+/, (m) => m.replace(/\d+/, '*'));
  const out = [];

  const r1 = await ztFetch(`${basePath}${sep}limit=${limit}&page=1`);
  if (!r1.ok) {
    STATE.skipped.push({ path: sanitizedPath, page: 1, reason: r1.reason });
    return out;
  }
  const items1 = r1.body[listKey] || [];
  out.push(...items1);
  if (items1.length === 0) return out;

  const total = typeof r1.body.total === 'number' ? r1.body.total : null;
  const MAX_PAGES = 20;

  if (total !== null) {
    if (out.length >= total) return out;
    const numPages = Math.min(Math.ceil(total / limit), MAX_PAGES);
    if (numPages <= 1) return out;
    const PAGE_CONCURRENCY = 4;
    const remaining = [];
    for (let p = 2; p <= numPages; p++) remaining.push(p);
    for (let i = 0; i < remaining.length; i += PAGE_CONCURRENCY) {
      const batch = remaining.slice(i, i + PAGE_CONCURRENCY);
      const results = await Promise.all(
        batch.map((p) => ztFetch(`${basePath}${sep}limit=${limit}&page=${p}`)),
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (!r.ok) {
          STATE.skipped.push({ path: sanitizedPath, page: batch[j], reason: r.reason });
          continue;
        }
        out.push(...(r.body[listKey] || []));
      }
    }
    return out;
  }

  for (let page = 2; page <= MAX_PAGES; page++) {
    const r = await ztFetch(`${basePath}${sep}limit=${limit}&page=${page}`);
    if (!r.ok) {
      STATE.skipped.push({ path: sanitizedPath, page, reason: r.reason });
      break;
    }
    const items = r.body[listKey] || [];
    if (items.length === 0) break;
    out.push(...items);
    if (items.length < limit) break;
  }
  return out;
}

// ---- field helpers ------------------------------------------------------

const USER_MAP = new Map();

function pickName(x) {
  if (x == null) return null;
  if (typeof x === 'string') {
    const s = x.trim();
    if (!s) return null;
    return USER_MAP.get(s) || s;
  }
  if (typeof x === 'object') return x.realname || x.account || null;
  return null;
}

// Like pickName but returns the raw account key (for me-comparison).
function pickAccount(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x.trim();
  if (typeof x === 'object') return (x.account || '').trim();
  return '';
}

async function loadUserMap() {
  const items = await ztPaginate('/users', 'users');
  for (const u of items) {
    if (u.account && u.realname) USER_MAP.set(u.account, u.realname);
  }
}

function flattenChildren(t) {
  const acc = [];
  const walk = (node) => {
    acc.push(node);
    let kids = node.children;
    if (kids && !Array.isArray(kids) && typeof kids === 'object') {
      kids = Object.values(kids);
    }
    if (Array.isArray(kids)) kids.forEach(walk);
  };
  walk(t);
  return acc;
}

// ---- main collection ----------------------------------------------------

async function fetchUserViews(me) {
  const r = await ztFetch('/user');
  if (!r.ok) {
    throw new Error(`/user fetch failed: ${r.reason || r.status}`);
  }
  const u = r.body || {};
  const myAccount = me || (u.profile && u.profile.account) || (u.account) || '';
  if (!myAccount) {
    throw new Error('cannot determine me (ZENTAO_ME unset and /user.profile.account missing)');
  }
  const view = (u.profile && u.profile.view) || u.view || {};
  const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    me: myAccount,
    sprintIds: Array.from(new Set(split(view.sprints))),
    productIds: Array.from(new Set(split(view.products))),
  };
}

function deriveTaskRecord(t, me, range, role) {
  const status = t.status || 'wait';
  const finishedBy = pickName(t.finishedBy);
  const assignedTo = pickName(t.assignedTo);
  const parentId = Number(t.parent || 0);
  const deadline = t.deadline && t.deadline !== '0000-00-00' ? String(t.deadline).slice(0, 10) : null;
  const finishedDate = t.finishedDate && !String(t.finishedDate).startsWith('0000') ? String(t.finishedDate).slice(0, 10) : null;
  const lastEditedDate = t.lastEditedDate && !String(t.lastEditedDate).startsWith('0000') ? String(t.lastEditedDate).slice(0, 10) : null;
  return {
    id: Number(t.id),
    name: t.name,
    parent_id: parentId,
    parent_name: null,                 // filled in by fillParentNames pass
    display_path: null,                // filled in by fillParentNames pass
    status,
    status_cn: STATUS_CN[status] || status,
    execution: Number(t.execution || t.executionID || 0) || null,
    deadline,
    finishedDate,
    lastEditedDate,
    assignedTo,
    finishedBy,
    pri: Number(t.pri || 0) || null,
    wk_role: role,                     // "完成" | "进行" | null(R4)
    _account_assigned: pickAccount(t.assignedTo),
    _account_finished: pickAccount(t.finishedBy),
  };
}

function deriveBugRecord(b, me) {
  const status = b.status || 'active';
  const type = b.type || 'others';
  const typeCn = BUG_TYPE_CN[type] || '非缺陷类';
  return {
    id: Number(b.id),
    title_raw: b.title,
    type,
    type_cn: typeCn,
    severity: Number(b.severity || 0),
    pri: Number(b.pri || 0) || null,
    status,
    status_cn: BUG_STATUS_CN[status] || status,
    resolution: b.resolution || null,
    openedDate: b.openedDate && !String(b.openedDate).startsWith('0000') ? String(b.openedDate).slice(0, 10) : null,
    openedBy: pickName(b.openedBy),
    resolvedDate: b.resolvedDate && !String(b.resolvedDate).startsWith('0000') ? String(b.resolvedDate).slice(0, 10) : null,
    resolvedBy: pickName(b.resolvedBy),
    closedDate: b.closedDate && !String(b.closedDate).startsWith('0000') ? String(b.closedDate).slice(0, 10) : null,
    closedBy: pickName(b.closedBy),
    assignedTo: pickName(b.assignedTo),
    productID: Number(b.product || 0) || null,
    _account_resolved: pickAccount(b.resolvedBy),
    _account_assigned: pickAccount(b.assignedTo),
  };
}

// Resolve parent_name + display_path for every task record. Parents that
// aren't already in the working set are fetched via /tasks/{id} (cheap,
// usually < 10 unique parent ids per week).
async function fillParentNames(records, knownParents) {
  // knownParents: Map<id, name> seeded with all task records (so a task that
  // happens to be both child-of-X and parent-of-Y can self-resolve).
  const needFetch = new Set();
  for (const r of records) {
    if (r.parent_id > 0 && !knownParents.has(r.parent_id)) needFetch.add(r.parent_id);
  }
  if (needFetch.size > 0) {
    const ids = Array.from(needFetch);
    const CONC = 5;
    for (let i = 0; i < ids.length; i += CONC) {
      const batch = ids.slice(i, i + CONC);
      const results = await Promise.all(batch.map((pid) => ztFetch(`/tasks/${pid}`)));
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.ok && r.body && r.body.id) {
          knownParents.set(Number(r.body.id), r.body.name || `T${r.body.id}`);
        }
      }
    }
  }
  for (const r of records) {
    if (r.parent_id > 0 && knownParents.has(r.parent_id)) {
      r.parent_name = knownParents.get(r.parent_id);
      r.display_path = `【T${r.parent_id}】${r.parent_name}/${r.name}`;
    } else {
      r.parent_name = null;
      r.display_path = `【T${r.id}】${r.name}`;
    }
  }
}

// Remove parent rows when at least one of their children is also in the set.
// Children already carry "父名/子名" prefix in display_path, so a separate
// parent row is redundant.
function dedupParents(records) {
  const childParentIds = new Set();
  for (const r of records) {
    if (r.parent_id > 0) childParentIds.add(r.parent_id);
  }
  return records.filter((r) => !childParentIds.has(r.id));
}

function buildBugRootCause(bugsResolved) {
  const acc = { '代码缺陷': 0, '配置问题': 0, '需求缺失': 0, '非缺陷类': 0 };
  for (const b of bugsResolved) {
    const k = BUG_ROOT_CAUSE_KEYS.includes(b.type_cn) ? b.type_cn : '非缺陷类';
    acc[k]++;
  }
  return acc;
}

function stripInternal(records) {
  return records.map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (!k.startsWith('_')) out[k] = v;
    }
    return out;
  });
}

// ---- diagnostics --------------------------------------------------------

let TRACE_T0 = Date.now();
function trace(msg) {
  process.stdout.write(`[trace +${((Date.now() - TRACE_T0) / 1000).toFixed(1)}s] ${msg}\n`);
}

const HARD_TIMEOUT_MS = parseInt(process.env.WEEKLY_HARD_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const _hardKill = setTimeout(() => {
  console.error(`FATAL: hard timeout (${HARD_TIMEOUT_MS}ms) reached, aborting`);
  process.exit(4);
}, HARD_TIMEOUT_MS);
_hardKill.unref();

function maybeWarnSize(payload) {
  const sizeKB = Buffer.byteLength(JSON.stringify(payload), 'utf-8') / 1024;
  if (sizeKB > 500) {
    process.stdout.write(`WARN: JSON ${sizeKB.toFixed(1)}KB > 500KB (very large)\n`);
  } else if (sizeKB > 80) {
    process.stdout.write(`WARN: JSON ${sizeKB.toFixed(1)}KB > 80KB\n`);
  }
  payload._meta.size_kb = Math.round(sizeKB * 10) / 10;
  return payload;
}

// ---- main ---------------------------------------------------------------

async function main() {
  TRACE_T0 = Date.now();
  trace('main start');
  const args = parseArgs(process.argv);
  const range = weekRange(args.week);
  trace(`week=${args.week} range=[${range.wk_start.slice(0, 10)}, ${range.wk_end.slice(0, 10)})`);

  STATE.baseUrl = requireEnv('ZENTAO_BASE_URL');
  requireEnv('ZENTAO_ACCOUNT');
  requireEnv('ZENTAO_PASSWORD');

  let token = readTokenFile();
  if (!token) {
    trace('refreshTokenViaBash');
    refreshTokenViaBash();
    token = readTokenFile();
    if (!token) {
      console.error('FATAL: failed to acquire token via zentao-api bridge');
      process.exit(1);
    }
  }
  STATE.token = token;
  const t0 = Date.now();

  // Phase 0: who am I + which sprints/products do I see
  await loadUserMap();
  const views = await fetchUserViews(process.env.ZENTAO_ME || null);
  trace(`me=${views.me} sprints=${views.sprintIds.length} products=${views.productIds.length} users=${USER_MAP.size}`);

  // Phase 1: filter sprints to those currently doing (avoid pulling closed
  // sprints which can flood the task fan-out with stale data). Mirrors V1
  // bash: comm -12 user_view_sprints doing_executions.
  const doingExecResp = await ztFetch('/executions?status=doing&limit=500');
  const doingExecIds = new Set();
  if (doingExecResp.ok) {
    for (const ex of (doingExecResp.body.executions || [])) {
      doingExecIds.add(String(ex.id));
    }
  } else {
    trace(`WARN /executions?status=doing failed: ${doingExecResp.reason}`);
  }
  const mySprints = views.sprintIds.filter((sid) => doingExecIds.has(String(sid)));
  trace(`mySprints=${mySprints.length} (intersected with status=doing)`);

  // Phase 2: pull tasks across mySprints (parallel, batched)
  const SPRINT_CONC = 5;
  const rawTasks = [];
  for (let i = 0; i < mySprints.length; i += SPRINT_CONC) {
    const batch = mySprints.slice(i, i + SPRINT_CONC);
    const results = await Promise.all(
      batch.map(async (sid) => ({ sid, list: await ztPaginate(`/executions/${sid}/tasks`, 'tasks') })),
    );
    for (const r of results) {
      trace(`sprint=${r.sid} tasks=${r.list.length}`);
      rawTasks.push(...r.list);
    }
  }

  // Phase 3: pull bugs across products (two passes per product:
  //   - resolved-this-week: needs ?status=all (closed bugs hidden by default)
  //   - active-snapshot:    no ?status=all (default already returns active)
  const PRODUCT_CONC = 5;
  const rawBugsAll = [];
  const rawBugsActive = [];
  for (let i = 0; i < views.productIds.length; i += PRODUCT_CONC) {
    const batch = views.productIds.slice(i, i + PRODUCT_CONC);
    const allResults = await Promise.all(
      batch.map(async (pid) => ({ pid, list: await ztPaginate(`/products/${pid}/bugs?status=all`, 'bugs') })),
    );
    const activeResults = await Promise.all(
      batch.map(async (pid) => ({ pid, list: await ztPaginate(`/products/${pid}/bugs`, 'bugs') })),
    );
    for (const r of allResults) {
      trace(`product=${r.pid} bugs(all)=${r.list.length}`);
      rawBugsAll.push(...r.list);
    }
    for (const r of activeResults) {
      trace(`product=${r.pid} bugs(active-snap)=${r.list.length}`);
      rawBugsActive.push(...r.list);
    }
  }

  // Phase 4: flatten + dedup tasks
  const flat = [];
  for (const t of rawTasks) flat.push(...flattenChildren(t));
  const seen = new Set();
  const dedup = flat.filter((t) => {
    const id = Number(t.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return t.deleted !== '1';
  });
  trace(`tasks: raw=${rawTasks.length} flat=${flat.length} dedup=${dedup.length}`);

  // Phase 5: classify into wk_role (完成 / 进行) and next-week
  const me = views.me;
  const tasksDone = [];
  const tasksProgress = [];
  const tasksNextWeek = [];
  for (const t of dedup) {
    const status = t.status || 'wait';
    const aAcc = pickAccount(t.assignedTo);
    const fAcc = pickAccount(t.finishedBy);
    const finishedDate = t.finishedDate && !String(t.finishedDate).startsWith('0000') ? String(t.finishedDate).slice(0, 10) : null;
    const lastEditedDate = t.lastEditedDate && !String(t.lastEditedDate).startsWith('0000') ? String(t.lastEditedDate).slice(0, 10) : null;
    const assignedDate = t.assignedDate && !String(t.assignedDate).startsWith('0000') ? String(t.assignedDate).slice(0, 10) : null;
    const deadline = t.deadline && t.deadline !== '0000-00-00' ? String(t.deadline).slice(0, 10) : null;

    // R1-完成: finishedBy == me && finishedDate ∈ [wk_start, wk_end)
    if (fAcc === me && dateInRange(finishedDate, range.wk_start, range.wk_end)) {
      tasksDone.push(deriveTaskRecord(t, me, range, '完成'));
      continue;
    }
    // R1-进行: assignedTo == me && status ∈ {doing,wait,pause}
    //   && (lastEditedDate || assignedDate) ∈ [wk_start, wk_end)
    if (aAcc === me && (status === 'doing' || status === 'wait' || status === 'pause')) {
      const editAt = lastEditedDate || assignedDate;
      if (dateInRange(editAt, range.wk_start, range.wk_end)) {
        tasksProgress.push(deriveTaskRecord(t, me, range, '进行'));
      }
    }
    // R4-下周: assignedTo == me && status ∈ {wait,doing} && deadline ∈ [next_s, next_e)
    if (aAcc === me && (status === 'wait' || status === 'doing')
        && dateInRange(deadline, range.next_s, range.next_e)) {
      tasksNextWeek.push(deriveTaskRecord(t, me, range, null));
    }
  }
  trace(`R1 done=${tasksDone.length} progress=${tasksProgress.length} | R4 next=${tasksNextWeek.length}`);

  // Phase 6: bugs filter
  const seenBugAll = new Set();
  const dedupBugAll = rawBugsAll.filter((b) => {
    const id = Number(b.id);
    if (!id || seenBugAll.has(id)) return false;
    seenBugAll.add(id);
    return true;
  });
  const seenBugActive = new Set();
  const dedupBugActive = rawBugsActive.filter((b) => {
    const id = Number(b.id);
    if (!id || seenBugActive.has(id)) return false;
    seenBugActive.add(id);
    return true;
  });

  const bugsResolved = dedupBugAll
    .filter((b) => pickAccount(b.resolvedBy) === me
      && dateInRange(b.resolvedDate, range.wk_start, range.wk_end))
    .map((b) => deriveBugRecord(b, me));
  const bugsActive = dedupBugActive
    .filter((b) => pickAccount(b.assignedTo) === me && (b.status || 'active') === 'active')
    .map((b) => deriveBugRecord(b, me));
  trace(`R2 resolved=${bugsResolved.length} | R3 active=${bugsActive.length}`);

  // Phase 7: parent-name resolution + dedup parents
  const knownParents = new Map();
  for (const r of [...tasksDone, ...tasksProgress, ...tasksNextWeek]) {
    knownParents.set(r.id, r.name);
  }
  await fillParentNames([...tasksDone, ...tasksProgress, ...tasksNextWeek], knownParents);

  // Parent dedup is per-section: don't drop a parent from tasks_done just
  // because a child shows up in tasks_next_week — they belong to different
  // narrative segments.
  const tasksDoneFinal = stripInternal(dedupParents(tasksDone));
  const tasksProgressFinal = stripInternal(dedupParents(tasksProgress));
  const tasksNextWeekFinal = stripInternal(dedupParents(tasksNextWeek));
  const bugsResolvedFinal = stripInternal(bugsResolved);
  const bugsActiveFinal = stripInternal(bugsActive);

  // Phase 8: summary + bug_root_cause ground truth
  const summary = {
    task_done: tasksDoneFinal.length,
    task_progress: tasksProgressFinal.length,
    bug_resolved: bugsResolvedFinal.length,
    bug_active: bugsActiveFinal.length,
    next_planned: tasksNextWeekFinal.length,
  };
  const bug_root_cause = buildBugRootCause(bugsResolvedFinal);

  let payload = {
    week: args.week,
    wk_start: range.wk_start,
    wk_end: range.wk_end,
    next_s: range.next_s,
    next_e: range.next_e,
    me,
    summary,
    bug_root_cause,
    tasks_done: tasksDoneFinal,
    tasks_progress: tasksProgressFinal,
    tasks_next_week: tasksNextWeekFinal,
    bugs_resolved: bugsResolvedFinal,
    bugs_active: bugsActiveFinal,
    _meta: {
      api_calls: STATE.apiCalls,
      duration_ms: Date.now() - t0,
      skipped: STATE.skipped,
      budget_exceeded: STATE.budgetExceeded,
      sprint_count: mySprints.length,
      product_count: views.productIds.length,
    },
  };

  payload = maybeWarnSize(payload);

  fs.writeFileSync(args.out, JSON.stringify(payload, null, 2));
  fs.chmodSync(args.out, 0o600);

  // Hard-fail when the API budget cap was hit. Without this, a too-low
  // WEEKLY_API_BUDGET produces a JSON that *looks* successful (exit 0, "OK"
  // line) but silently drops entire bug pages — exactly how cron would push
  // a hollow weekly report to the vault. The partial JSON is still written
  // for diagnostic inspection. Override with --allow-partial or
  // WEEKLY_ALLOW_PARTIAL=1 when intentionally probing with a small budget.
  const skippedByBudget = STATE.skipped.filter((s) => s.reason === 'budget').length;
  if (STATE.budgetExceeded && !args.allowPartial) {
    const suggested = Math.max(STATE.budget * 2, 4000);
    console.error(
      `FATAL: WEEKLY_API_BUDGET=${STATE.budget} exhausted (${skippedByBudget} pages skipped). `
      + `Data in ${args.out} is partial. `
      + `Set WEEKLY_API_BUDGET=${suggested} (or higher) and re-run, `
      + `or pass --allow-partial / WEEKLY_ALLOW_PARTIAL=1 to suppress.`,
    );
    process.exit(5);
  }

  process.stdout.write(`OK week=${args.week} me=${me} api_calls=${STATE.apiCalls} done=${summary.task_done} progress=${summary.task_progress} bug_resolved=${summary.bug_resolved} bug_active=${summary.bug_active} next=${summary.next_planned} → ${args.out}\n`);
}

main()
  .then(() => {
    clearTimeout(_hardKill);
    // Normal-path exit. Hard-fail paths (budget_exceeded, missing token, etc.)
    // already called process.exit() with their own non-zero code.
    process.exit(0);
  })
  .catch((e) => {
    clearTimeout(_hardKill);
    console.error(`FATAL: ${sanitizeMessage(e.message)}`);
    process.exit(1);
  });
