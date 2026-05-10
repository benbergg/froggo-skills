#!/usr/bin/env node
// exp-compass-daily / collect.js
// Pulls Zentao stories/tasks/bugs for a single product, derives helper fields,
// writes a normalized JSON consumable by the AI writing layer.
//
// Usage:
//   node collect.js [--product 95] [--date 2026-05-07] [--out /tmp/exp-compass-{DATE}.json]
//
// Required env: ZENTAO_BASE_URL, ZENTAO_ACCOUNT, ZENTAO_PASSWORD
// Optional env: ZENTAO_CACHE_DIR, XDG_CACHE_HOME, EXP_COMPASS_API_BUDGET
//
// Token bridge (see V2 design § 3.4): reads $ZT_CACHE/token.json maintained by
// zentao-api skill; on 401 spawns `bash -c 'source zt-functions.sh; zt_acquire_token'`
// to refresh. Never re-implements /tokens API.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- env autoloading -----------------------------------------------------
// Auto-source common .env files when running outside an interactive shell
// (e.g. openclaw cron). preflight rejects "set -a; source ..." composite
// shell commands, so we read .env files directly with zero deps.
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

const STAGE_CN = {
  wait: '未开始', planned: '未开始', projected: '未开始', draft: '未开始',
  developing: '研发中', developed: '研发完毕', tested: '测试完毕',
  released: '已发布', verified: '已验收', closed: '已完成',
};

const STATUS_CN = {
  wait: '未开始', doing: '进行中', done: '已完成', pause: '暂停',
  blocked: '阻塞', cancel: '取消', closed: '已关闭',
};

const STAGE_FALLBACK_PCT = {
  wait: 0, planned: 0, projected: 20, draft: 0, draft_: 0,
  developing: 50, developed: 80, tested: 90,
  released: 100, verified: 100, closed: 100,
};

const STAGE_IN_PROGRESS = ['developing', 'developed', 'tested'];
const STAGE_TODO = ['wait', 'planned', 'projected', 'draft'];
const STAGE_DONE = ['closed', 'released', 'verified'];
// "Completed for daily-report purposes": includes tested, since in this Zentao
// workflow stage=tested with closedDate=null is still a meaningful "today done"
// signal (dev/test cycle finished, awaiting formal close).
const STAGE_COMPLETED = ['tested', 'released', 'verified', 'closed'];

const TASK_TODO_STATUSES = ['wait', 'pause', 'blocked'];
const TASK_DONE_STATUSES = ['done', 'closed'];

// ---- arg parsing --------------------------------------------------------

function parseArgs(argv) {
  const out = { product: '95', date: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--product') { out.product = v; i++; }
    else if (k === '--date') { out.date = v; i++; }
    else if (k === '--out') { out.out = v; i++; }
  }
  if (!out.date) {
    const d = new Date();
    out.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (!out.out) out.out = `/tmp/exp-compass-${out.date}.json`;
  return out;
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
  // Locate zentao-api zt-functions.sh next to this skill (siblings under skills/).
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
  budget: parseInt(process.env.EXP_COMPASS_API_BUDGET || '300', 10),
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

      // sanitize control chars (zt-functions.sh tr -d '\000-\037' equivalent)
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
  // basePath like '/products/95/bugs?status=all'
  // listKey: explicit field name to read items from (avoid heuristic-induced confusion).
  const sep = basePath.includes('?') ? '&' : '?';
  const limit = 500;
  const sanitizedPath = basePath.replace(/\/products\/\d+|\/projects\/\d+|\/executions\/\d+/, (m) => m.replace(/\d+/, '*'));
  const out = [];

  // Page 1 first to discover total; subsequent pages can then be fetched
  // in parallel instead of one-after-another. Big paginated endpoints like
  // /products/{id}/bugs?status=all (1100+ rows) drop from 3 sequential
  // round-trips to roughly 1 wall-clock round-trip after the first.
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

  // Endpoint doesn't expose total: fall back to sequential pull with the
  // length heuristic + empty-page defense (legacy behavior).
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

// account → realname map populated at startup from /users.
// pickName uses this to resolve string accounts ("qingwa") to their realname ("青蛙")
// because Zentao's person fields are inconsistent: sometimes the API returns the
// account as a bare string, other times the full {account, realname, ...} object.
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

async function loadUserMap() {
  // /users returns { users: [{account, realname, ...}], total }.
  // Populate USER_MAP; on failure leave empty (pickName falls back to the string itself).
  const items = await ztPaginate('/users', 'users');
  for (const u of items) {
    if (u.account && u.realname) USER_MAP.set(u.account, u.realname);
  }
}

// Server-side closedDate-desc + client-side early-exit. Probed 2026-05-10
// against this Zentao instance: `?...&order=closedDate_desc` returns rows in
// strict closedDate descending order, with null closedDate sorted last —
// so the first non-matching row proves no later row matches either.
//
// Used for two scope-bound queries that previously paginated thousands of
// rows just to surface today's events:
//   - closed stories  (was ~540 rows → 0-5 today)
//   - closed bugs     (was ~1100 rows → 0-10 today)
//
// Falls back to a full paginate + client filter on transport failure,
// preserving correctness if the order parameter is ever rejected.
async function fetchClosedTodayStories(productId, date) {
  const url = `/products/${productId}/stories?status=closedstory&order=closedDate_desc&limit=500&page=1`;
  const r = await ztFetch(url);
  if (!r.ok) {
    trace(`closedToday filtered fetch failed (${r.reason}); falling back to full paginate`);
    const all = await ztPaginate(`/products/${productId}/stories?status=closedstory`, 'stories');
    return all.filter((s) => s.closedDate && startsWithDate(s.closedDate, date));
  }
  const items = r.body.stories || [];
  const out = [];
  for (const s of items) {
    if (!s.closedDate) continue;
    const day = String(s.closedDate).slice(0, 10);
    if (day < date) break;
    if (day === date) out.push(s);
    // day > date: clock skew or future-dated row — keep scanning, don't break
  }
  return out;
}

// Bugs scope is asymmetric: ALL unclosed bugs (active + resolved) plus only
// the closed bugs whose closedDate is today. The previous approach pulled
// `?status=all` (1100+ rows on this product) to filter ~25 in-scope rows.
// Two queries instead — one tiny, one early-exit — get the same result
// without the wall-of-bugs round trip.
//
// Note on the Zentao bugs API: status=active|resolved|closed all return 0;
// only status=all and status=unclosed (= active + resolved) are accepted.
async function fetchTodayClosedBugs(productId, date) {
  const url = `/products/${productId}/bugs?status=all&order=closedDate_desc&limit=500&page=1`;
  const r = await ztFetch(url);
  if (!r.ok) return null;
  const items = r.body.bugs || [];
  const out = [];
  for (const b of items) {
    // Active + resolved bugs have closedDate=null and Zentao sorts them at
    // the tail under closedDate_desc; encountering one means we've passed
    // every closed row newer than `date`.
    if (!b.closedDate) break;
    const day = String(b.closedDate).slice(0, 10);
    if (day < date) break;
    if (day === date) out.push(b);
  }
  return out;
}

async function fetchBugsInScope(productId, date) {
  const [unclosed, closedTodayMaybe] = await Promise.all([
    ztPaginate(`/products/${productId}/bugs?status=unclosed`, 'bugs'),
    fetchTodayClosedBugs(productId, date),
  ]);
  if (closedTodayMaybe === null) {
    trace('bugs closed-today fetch failed; falling back to full paginate');
    return ztPaginate(`/products/${productId}/bugs?status=all`, 'bugs');
  }
  const seen = new Set();
  const out = [];
  for (const b of [...unclosed, ...closedTodayMaybe]) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
  }
  return out;
}

function startsWithDate(iso, date) {
  if (!iso) return false;
  return String(iso).slice(0, 10) === date;
}

function flattenChildren(t) {
  // Tree of tasks: include parent's children as separate task records when present.
  // The function returns a flat list including the parent itself + all descendants.
  // children may also be an object map keyed by id (Zentao quirk on some endpoints).
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

// progress: hours-priority, fallback to stage estimate
function computeProgress(taskList, stage) {
  let consumed = 0, left = 0, hasHours = false;
  for (const t of taskList) {
    const c = Number(t.consumed || 0);
    const l = Number(t.left || 0);
    if (c + l > 0) hasHours = true;
    consumed += c;
    left += l;
  }
  if (hasHours && consumed + left > 0) {
    return { progress_pct: Math.round((consumed / (consumed + left)) * 100), progress_source: '工时' };
  }
  const fb = STAGE_FALLBACK_PCT[stage] ?? 0;
  return { progress_pct: fb, progress_source: '阶段' };
}

function deriveTask(t, date) {
  const status = t.status || 'wait';
  const isDone = TASK_DONE_STATUSES.includes(status);
  const finishedBy = pickName(t.finishedBy);
  const assignedTo = pickName(t.assignedTo);
  const deadline = t.deadline && t.deadline !== '0000-00-00' ? t.deadline : null;
  const todayLocal = date; // YYYY-MM-DD
  const isOverdue = !!deadline && deadline < todayLocal && !isDone;

  return {
    id: t.id,
    name: t.name,
    type: t.type,
    storyID: Number(t.story || t.storyID || 0),
    parent: Number(t.parent || 0),
    status,
    status_cn: STATUS_CN[status] || status,
    assignedTo,
    finishedBy,
    openedBy: pickName(t.openedBy),
    display_handler: isDone ? (finishedBy || assignedTo) : (assignedTo || finishedBy),
    deadline,
    is_overdue: isOverdue,
    is_normal: !isOverdue,
    consumed: Number(t.consumed || 0),
    left: Number(t.left || 0),
    is_today_created: startsWithDate(t.openedDate, date),
    is_today_finished: startsWithDate(t.finishedDate, date),
    openedDate: t.openedDate || null,
    finishedDate: t.finishedDate || null,
  };
}

function deriveBug(b, date) {
  const status = b.status || 'active';
  const resolvedBy = pickName(b.resolvedBy);
  const closedBy = pickName(b.closedBy);
  // display_handlers: ordered, deduplicated list of "who acted on this bug".
  // Used by AI when rendering the "修复 Bug" section to show all relevant handlers
  // (resolver + closer) instead of picking just one.
  const handlers = [];
  if (resolvedBy) handlers.push(resolvedBy);
  if (closedBy && !handlers.includes(closedBy)) handlers.push(closedBy);
  return {
    id: b.id,
    title: b.title,
    status,
    status_cn: status === 'active' ? '待处理'
      : status === 'resolved' ? '已解决待验'
      : status === 'closed' ? '已关闭'
      : status,
    severity: Number(b.severity || 0),
    openedBy: pickName(b.openedBy),
    openedDate: b.openedDate || null,
    resolvedBy,
    resolvedDate: b.resolvedDate || null,
    closedBy,
    closedDate: b.closedDate || null,
    assignedTo: pickName(b.assignedTo),
    display_handlers: handlers,
    is_today_opened: startsWithDate(b.openedDate, date),
    is_today_resolved: startsWithDate(b.resolvedDate, date),
    is_today_closed: startsWithDate(b.closedDate, date),
  };
}

function deriveStory(s, tasksOfStory, date) {
  const stage = s.stage || 'wait';
  const closedDate = s.closedDate && s.closedDate !== '0000-00-00 00:00:00' ? s.closedDate : null;
  // story.is_today_done — single authoritative signal (per user decision A):
  //   stage=closed AND closedDate today  →  formally closed today
  // Earlier we also accepted B (stage∈{tested,released,verified} with task
  // today_finished) as "test passed today", but tested-stage stories are
  // still in flight (closedDate=null) — they belong in "需求推进" only,
  // not "今日完成的需求".
  const isTodayDone = stage === 'closed' && startsWithDate(closedDate, date);

  // progress is computed only over leaf tasks of this story.
  const leaves = tasksOfStory.filter((t) => !tasksOfStory.some((c) => c.parent === t.id));
  const prog = computeProgress(leaves, stage);

  return {
    id: s.id,
    title: s.title,
    stage,
    stage_cn: STAGE_CN[stage] || stage,
    progress_pct: prog.progress_pct,
    progress_source: prog.progress_source,
    openedBy: pickName(s.openedBy),
    openedDate: s.openedDate || null,
    closedBy: pickName(s.closedBy),
    closedDate,
    is_today_opened: startsWithDate(s.openedDate, date),
    is_today_done: isTodayDone,
    tasks: tasksOfStory,
  };
}

// ---- main collection ----------------------------------------------------

async function fetchProductName(productId) {
  // Prefer cached user.json (zentao-api side-effect); fallback to /products/{id}.
  const userJson = path.join(ztCacheDir(), 'user.json');
  if (fs.existsSync(userJson)) {
    try {
      const u = JSON.parse(fs.readFileSync(userJson, 'utf-8'));
      const products = u.profile && u.profile.view && u.profile.view.products;
      if (products && products[productId]) return products[productId];
    } catch (_) { /* ignore, fallback */ }
  }
  const r = await ztFetch(`/products/${productId}`);
  if (r.ok) return r.body.name || `Product-${productId}`;
  return `Product-${productId}`;
}

function inScopeStory(s, date) {
  const stage = s.stage || 'wait';
  if (STAGE_IN_PROGRESS.includes(stage) || STAGE_TODO.includes(stage)) return true;
  // Closed/released/verified stories: only today-closed are in scope.
  // (lastEditedDate dropped — too noisy; rawStories merge already filters this.)
  if (STAGE_DONE.includes(stage)) return startsWithDate(s.closedDate, date);
  return false;
}

function inScopeBug(b, date) {
  const status = b.status || 'active';
  if (status === 'active' || status === 'resolved') return true;
  // closed bugs only if closed/resolved/opened today
  return startsWithDate(b.openedDate, date)
    || startsWithDate(b.resolvedDate, date)
    || startsWithDate(b.closedDate, date);
}

function buildSummary(stories, allTasks, bugs) {
  const cntStory = (pred) => stories.filter(pred).length;
  const cntTask = (pred) => allTasks.filter(pred).length;
  const cntBug = (pred) => bugs.filter(pred).length;

  return {
    story: {
      in_progress: cntStory((s) => STAGE_IN_PROGRESS.includes(s.stage)),
      today_new: cntStory((s) => s.is_today_opened),
      today_done: cntStory((s) => s.is_today_done),
      todo: cntStory((s) => STAGE_TODO.includes(s.stage)),
    },
    task: {
      in_progress: cntTask((t) => t.status === 'doing'),
      today_new: cntTask((t) => t.is_today_created),
      // today_done excludes aggregate parents: parent + child finishing the
      // same day shouldn't double-count when the parent's "done" is just an
      // aggregation of its children's actual work.
      today_done: cntTask((t) => t.is_today_finished && !t.is_aggregate_parent),
      todo: cntTask((t) => TASK_TODO_STATUSES.includes(t.status)),
    },
    bug: {
      in_progress: cntBug((b) => b.status === 'resolved'),
      today_new: cntBug((b) => b.is_today_opened),
      today_done: cntBug((b) => b.is_today_closed),
      todo: cntBug((b) => b.status === 'active'),
    },
  };
}

function maybeDegrade(payload) {
  const sizeKB = Buffer.byteLength(JSON.stringify(payload), 'utf-8') / 1024;
  if (sizeKB > 200) {
    console.error(`FATAL: JSON ${sizeKB.toFixed(1)}KB exceeds 200KB cap`);
    process.exit(1);
  }
  if (sizeKB > 80) {
    process.stdout.write(`WARN: JSON ${sizeKB.toFixed(1)}KB > 80KB, applying degrade (truncate non-essential tasks)\n`);
    for (const s of payload.stories) {
      s.tasks = s.tasks.filter((t) => t.status === 'doing'
        || TASK_TODO_STATUSES.includes(t.status)
        || t.is_today_created
        || t.is_today_finished
        || t.is_overdue);
    }
    payload._meta.degraded = true;
  } else if (sizeKB > 30) {
    process.stdout.write(`WARN: JSON ${sizeKB.toFixed(1)}KB > 30KB\n`);
  }
  payload._meta.size_kb = Math.round(sizeKB * 10) / 10;
  return payload;
}

// Hard wall-clock limit. Past tencent-vm cron runs left orphan collect.js
// processes blocked indefinitely (suspected: spawnSync token refresh + a
// long-poll edge case). 10 minutes covers the observed worst-case ~5min runs
// (Zentao slow + N+1 executions across 5+ projects) with headroom, while
// staying well below the cron 1800s ceiling so the wrapper still has room to
// run AI write-up + push steps after collect.js exits. Override via
// EXP_COMPASS_HARD_TIMEOUT_MS for tests or one-off cron tuning.
const HARD_TIMEOUT_MS = parseInt(process.env.EXP_COMPASS_HARD_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const _hardKill = setTimeout(() => {
  console.error(`FATAL: hard timeout (${HARD_TIMEOUT_MS}ms) reached, aborting`);
  process.exit(4);
}, HARD_TIMEOUT_MS);
_hardKill.unref();

// Progress signal goes to stdout so wrapping schedulers (openclaw helios
// `process poll`, etc.) can observe it. stderr is reserved for FATAL/throw.
// Always-on so silent stuck windows are observable without env tweaking.
function trace(msg) {
  process.stdout.write(`[trace +${((Date.now() - TRACE_T0) / 1000).toFixed(1)}s] ${msg}\n`);
}
let TRACE_T0 = Date.now();

async function main() {
  TRACE_T0 = Date.now();
  trace('main start');
  const args = parseArgs(process.argv);
  STATE.baseUrl = requireEnv('ZENTAO_BASE_URL');
  requireEnv('ZENTAO_ACCOUNT');
  requireEnv('ZENTAO_PASSWORD');
  trace('env validated');

  let token = readTokenFile();
  trace(`readTokenFile: ${token ? 'cached' : 'absent'}`);
  if (!token) {
    trace('refreshTokenViaBash start');
    refreshTokenViaBash();
    trace('refreshTokenViaBash done');
    token = readTokenFile();
    if (!token) {
      console.error('FATAL: failed to acquire token via zentao-api bridge');
      process.exit(1);
    }
  }
  STATE.token = token;

  const t0 = Date.now();

  // Phase 1: kick off the six independent root endpoints in parallel. They
  // share no data dependency, so the wall-clock cost collapses from
  // sum(loadUserMap, productName, activeStories, closedStories, bugs,
  // projects) to max(...). Each ztPaginate now also fans out its own page-2+
  // requests internally (see ztPaginate), so total in-flight fan-out can
  // reach ~6 endpoints × up to 4 pages each — Zentao tolerates this in
  // testing, and the 30s per-request timeout still bounds the worst case.
  //
  // Stories on this Zentao instance need TWO queries:
  //   - `/products/{id}/stories` (no status) → activestory only (in-progress + todo)
  //   - `/products/{id}/stories?status=closedstory` → all closed; client-side filter to today
  //   `?status=all` returns empty on this instance, so we can't combine them.
  trace('phase1 concurrent fetch start');
  const tPhase1Start = Date.now();
  const [
    , // loadUserMap returns void; result side-effects USER_MAP only
    productName,
    activeStories,
    closedToday,
    rawBugs,
    projectsResp,
  ] = await Promise.all([
    loadUserMap(),
    fetchProductName(args.product),
    ztPaginate(`/products/${args.product}/stories`, 'stories'),
    fetchClosedTodayStories(args.product, args.date),
    fetchBugsInScope(args.product, args.date),
    ztFetch(`/products/${args.product}/projects`),
  ]);
  const tPhase1Ms = Date.now() - tPhase1Start;
  trace(`phase1 done in ${tPhase1Ms}ms: users=${USER_MAP.size} product=${productName} active=${activeStories.length} closedToday=${closedToday.length} bugs=${rawBugs.length}`);

  // Merge (active + today-closed). De-dup by id (active should never overlap
  // closed, but be safe).
  const seenStoryIds = new Set();
  const rawStories = [];
  for (const s of [...activeStories, ...closedToday]) {
    if (seenStoryIds.has(s.id)) continue;
    seenStoryIds.add(s.id);
    rawStories.push(s);
  }
  // Track ALL VOC product story ids (active + closedToday) — used to filter
  // out cross-product task pollution from /executions/{eid}/tasks.
  // Note: closedStoriesAll is intentionally NOT included (those stories are
  // out of date scope; their tasks shouldn't appear in today's report).
  const productStoryIds = new Set(rawStories.map((s) => s.id));

  // Phase 2: tasks. NOT directly available under /products/{id}/tasks (returns
  // "not found") — must traverse product → projects → executions → tasks.
  // Pull every project's executions in parallel, then flatten across project
  // boundaries before the tasks fan-out. The earlier per-project loop was the
  // longest serial section in the script.
  //
  // Wall-clock budget: this loop can take 2-5 minutes against a slow Zentao,
  // and we'd rather emit a partial JSON than be SIGKILLed by the hard timeout
  // mid-write. Reserve BUDGET_RESERVE_MS for the downstream merge / derive /
  // writeFile path; once the elapsed time crosses (HARD_TIMEOUT - reserve),
  // stop enqueueing new batches, mark the JSON degraded, and let main finish.
  const rawTasks = [];
  let wallClockEarlyExit = false;
  const tPhase2Start = Date.now();
  if (projectsResp.ok) {
    const projects = projectsResp.body.projects || [];
    trace(`fetch projects done (${projects.length})`);
    const execResults = await Promise.all(
      projects.map(async (proj) => {
        const r = await ztFetch(`/projects/${proj.id}/executions`);
        return {
          projId: proj.id,
          ok: r.ok,
          execs: r.ok ? (r.body.executions || []) : [],
          reason: r.ok ? null : r.reason,
        };
      }),
    );
    const allExecs = [];
    for (const er of execResults) {
      if (!er.ok) {
        trace(`fetch project=${er.projId} executions failed: ${er.reason}`);
        continue;
      }
      trace(`fetch project=${er.projId} executions done (${er.execs.length})`);
      for (const ex of er.execs) allExecs.push(ex);
    }
    trace(`total executions to fetch tasks: ${allExecs.length}`);
    // Cross-project flat batching: 5 concurrent task fetches at any time,
    // independent of which project owns each execution. This is the main
    // win over the previous per-project 5-way batching, which idled the
    // pool whenever a project had < 5 executions.
    const TASK_CONCURRENCY = 5;
    const BUDGET_RESERVE_MS = 60_000;
    const wallDeadlineMs = HARD_TIMEOUT_MS - BUDGET_RESERVE_MS;
    for (let i = 0; i < allExecs.length; i += TASK_CONCURRENCY) {
      const elapsedMs = Date.now() - TRACE_T0;
      if (elapsedMs > wallDeadlineMs) {
        const remaining = allExecs.length - i;
        trace(`WARN: wall-clock budget exhausted at ${(elapsedMs / 1000).toFixed(1)}s; skipping ${remaining} executions to leave ${BUDGET_RESERVE_MS / 1000}s for downstream`);
        STATE.skipped.push({
          path: '/executions/*/tasks',
          reason: 'wall-clock-budget',
          remaining,
        });
        wallClockEarlyExit = true;
        break;
      }
      const batch = allExecs.slice(i, i + TASK_CONCURRENCY);
      trace(`fetch executions batch start [${batch.map((e) => e.id).join(',')}]`);
      const results = await Promise.all(
        batch.map(async (ex) => ({
          id: ex.id,
          tasks: await ztPaginate(`/executions/${ex.id}/tasks`, 'tasks'),
        })),
      );
      for (const r of results) {
        trace(`fetch execution=${r.id} tasks done (${r.tasks.length})`);
        rawTasks.push(...r.tasks);
      }
    }
  } else {
    trace(`fetch projects failed: ${projectsResp.reason}`);
    STATE.skipped.push({ path: `/products/*/projects`, reason: projectsResp.reason });
  }
  const tPhase2Ms = Date.now() - tPhase2Start;
  trace(`phase2 done in ${tPhase2Ms}ms (rawTasks=${rawTasks.length}${wallClockEarlyExit ? ', partial' : ''})`);

  // Scope-filter stories
  const scopedStories = rawStories.filter((s) => inScopeStory(s, args.date));
  const scopedStoryIds = new Set(scopedStories.map((s) => s.id));

  // Scope-filter & flatten tasks
  // Include children recursively, then keep tasks whose storyID is in scope OR
  // whose openedDate/finishedDate is today (loose tasks).
  const flatTasks = [];
  for (const t of rawTasks) flatTasks.push(...flattenChildren(t));
  // Deduplicate by id (parent + children may overlap if API includes both)
  const seen = new Set();
  const dedupTasks = flatTasks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return t.deleted !== '1';
  });

  const tasksDerivedAll = dedupTasks.map((t) => deriveTask(t, args.date));

  // Mark aggregate parents: a task is an aggregate parent if at least one of
  // its direct children is is_today_finished. AI's "完成任务" section should skip
  // these to avoid the parent + child duplication user reported (e.g. T43911 主
  // 任务 + T43913 子测试任务 同名同日完成).
  const todayFinishedIds = new Set(
    tasksDerivedAll.filter((t) => t.is_today_finished).map((t) => t.id),
  );
  const parentsWithTodayFinishedChild = new Set();
  for (const t of tasksDerivedAll) {
    if (t.parent && t.parent !== -1 && t.parent !== 0 && todayFinishedIds.has(t.id)) {
      parentsWithTodayFinishedChild.add(t.parent);
    }
  }
  for (const t of tasksDerivedAll) {
    t.is_aggregate_parent = parentsWithTodayFinishedChild.has(t.id);
  }

  const tasksAttachedToStory = tasksDerivedAll.filter((t) => scopedStoryIds.has(t.storyID));
  // loose_tasks must belong to THIS product:
  //   - either storyID is 0 (no story attached, i.e. truly loose)
  //   - or storyID is in this product's full story-id set (productStoryIds)
  // Plus today-created or today-finished. This excludes cross-product pollution
  // where /executions/{eid}/tasks returns tasks from sibling products' stories.
  const looseTasks = tasksDerivedAll.filter(
    (t) => !scopedStoryIds.has(t.storyID)
      && (t.storyID === 0 || productStoryIds.has(t.storyID))
      && (t.is_today_created || t.is_today_finished),
  );

  // Group attached tasks by story
  const tasksByStory = new Map();
  for (const t of tasksAttachedToStory) {
    if (!tasksByStory.has(t.storyID)) tasksByStory.set(t.storyID, []);
    tasksByStory.get(t.storyID).push(t);
  }

  const stories = scopedStories.map((s) => deriveStory(s, tasksByStory.get(s.id) || [], args.date));

  // Bugs: filter & derive
  const bugs = rawBugs.filter((b) => inScopeBug(b, args.date)).map((b) => deriveBug(b, args.date));

  // Summary uses ALL tasks visible in JSON (stories.tasks ∪ loose_tasks)
  const allTasksForSummary = [...tasksAttachedToStory, ...looseTasks];
  const summary = buildSummary(stories, allTasksForSummary, bugs);

  const today_start_iso = `${args.date}T00:00:00+08:00`;

  let payload = {
    date: args.date,
    today_start: today_start_iso,
    product: { id: Number(args.product), name: productName },
    summary,
    stories,
    loose_tasks: looseTasks,
    bugs,
    _meta: {
      api_calls: STATE.apiCalls,
      duration_ms: Date.now() - t0,
      timings: {
        phase1_ms: tPhase1Ms,
        phase2_ms: tPhase2Ms,
      },
      skipped: STATE.skipped,
      budget_exceeded: STATE.budgetExceeded,
      wall_clock_early_exit: wallClockEarlyExit,
    },
  };

  payload = maybeDegrade(payload);

  fs.writeFileSync(args.out, JSON.stringify(payload, null, 2));
  fs.chmodSync(args.out, 0o600);

  process.stdout.write(`OK product=${args.product} date=${args.date} api_calls=${STATE.apiCalls} stories=${stories.length} tasks=${allTasksForSummary.length} bugs=${bugs.length} → ${args.out}\n`);
}

main()
  .then(() => {
    clearTimeout(_hardKill);
    process.exit(0);
  })
  .catch((e) => {
    clearTimeout(_hardKill);
    console.error(`FATAL: ${sanitizeMessage(e.message)}`);
    process.exit(1);
  });
