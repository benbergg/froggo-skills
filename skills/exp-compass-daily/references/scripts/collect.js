#!/usr/bin/env node
// exp-compass-daily / collect.js
// Pulls Zentao stories/tasks/bugs for a single product, derives helper fields,
// writes a normalized JSON consumable by the AI writing layer.
//
// Usage:
//   node collect.js [--product 95] [--date 2026-05-07] [--out /tmp/exp-compass-{DATE}.json]
//
// Required env: ZENTAO_BASE_URL, ZENTAO_ACCOUNT, ZENTAO_PASSWORD
// Optional env: ZENTAO_CACHE_DIR, XDG_CACHE_HOME, EXP_COMPASS_PRODUCTS,
//               EXP_COMPASS_API_BUDGET, EXP_COMPASS_HARD_TIMEOUT_MS
//
// Env loading: this script trusts process.env only. The caller is responsible
// for injecting the env (shell rc for local, systemd EnvironmentFile for cron).
//
// Token bridge (see V2 design § 3.4): reads $ZT_CACHE/token.json maintained by
// zentao-api skill; on 401 spawns `bash -c 'source zt-functions.sh; zt_acquire_token'`
// to refresh. Never re-implements /tokens API.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

// VOC-owned project ids — projects whose executions are considered VOC's
// own work, even when their tasks have no story attached (storyID=0).
// 2026-05-13: introduced after iPaaS-owned tasks (T44099/T44098 "618 大促慢
// SQL 优化") leaked into the daily report via the loose-task path. A task on
// an execution outside this list must have a VOC-scoped storyID to be kept.
// Override via EXP_COMPASS_VOC_PROJECT_IDS=3084,2353,...
const DEFAULT_VOC_OWNED_PROJECT_IDS = [3084, 2353, 1829, 1845, 2023];
// 2026-07-24 V5: loose task(忘关联 story 的 VOC 散活)兜底项目。VOC 标品
// 日常迭代(当前 exec=2028)几乎是 loose task 唯一来源;仅并入该项目的
// doing exec,避免退化回全遍历(project 3084 有 28 个 doing exec)。
const DEFAULT_LOOSE_BACKFILL_PROJECT_ID = 2023;

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
  // 重试 3 次(间隔 5s):2026-07-22 实证 token 在跑到第 288 次调用时过期,
  // zt_acquire_token 单次瞬时失败导致 bugs?status=unclosed 整页被 skip,
  // 当天日报 active/resolved bug 全部静默丢失(B57142 事件)。
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    const r = spawnSync('bash', ['-c', `source "${zentaoFn}" && zt_init && zt_acquire_token >/dev/null`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    if (r.status === 0) return;
    lastErr = (r.stderr || '').toString().slice(0, 200);
    if (i < 2) spawnSync('sleep', ['5']);
  }
  throw new Error(`zt_acquire_token failed after 3 attempts: ${lastErr}`);
}

// ---- HTTP layer ---------------------------------------------------------

const STATE = {
  baseUrl: '',
  token: '',
  apiCalls: 0,
  // 2026-07-23: 300 → 600。executions 分页取齐后集合 87→112,phase2 需
  // 112×3=336 次 scoped 调用 + phase1 ~10 + executions 分页 ~15 ≈ 365,
  // 300 必爆(实证 19 个 execution 因 budget skip → exit 2)。600 留
  // ~1.6x 余量,仍能挡住失控循环。
  budget: parseInt(process.env.EXP_COMPASS_API_BUDGET || '600', 10),
  budgetExceeded: false,
  skipped: [],
};

function sanitizeMessage(s) {
  return String(s).replace(/Token:\s*\S+/gi, 'Token: ***').replace(/token=\S+/gi, 'token=***');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 单请求超时。2026-07-27 实测:该禅道实例 /executions/{id}/tasks 串行单调用
// 就要 11.5-59.3s(与任务数无关,total=73 的 exec 3436 反而最慢 59.3s),15s
// 上限低于端点常态耗时 → 每次调用必 abort。慢端点走 SLOW_REQ_TIMEOUT_MS。
// 60s 而非 25s:实测慢窗下 /products/95/stories?status=closedstory 单次
// 就撞 25s(2026-07-27 实跑 +25.1s abort),而"今日完成需求"是日报核心字段,
// 宁可多等也不能让它静默为空。
const REQ_TIMEOUT_MS = parseInt(process.env.EXP_COMPASS_REQ_TIMEOUT_MS || '60000', 10);
const SLOW_REQ_TIMEOUT_MS = parseInt(process.env.EXP_COMPASS_SLOW_REQ_TIMEOUT_MS || '90000', 10);

async function ztFetch(pathAndQuery, { allowRefresh = true, timeoutMs = REQ_TIMEOUT_MS } = {}) {
  if (STATE.apiCalls >= STATE.budget) {
    STATE.budgetExceeded = true;
    return { ok: false, status: 0, body: null, reason: 'budget' };
  }
  STATE.apiCalls++;

  const url = STATE.baseUrl + pathAndQuery;
  // Backoff shrunk from 4 retries (1+2+4+8s) to 2 (1+2s) and per-request
  // timeout from 30s to 15s after 2026-05-12 cron self-kill: a single
  // unresponsive endpoint could previously eat 4×30+15 = 135s of the 600s
  // hard budget before failure. Zentao P95 against this instance is ~10s;
  // 15s still covers the slow-tail without enabling cascading retries.
  //
  // 2026-07-27 修正:15s 假设失效(见 REQ_TIMEOUT_MS 注释)。超时值改可配,
  // 且**自身超时(AbortError)不再重试**——重试只是把一次 90s 的慢响应放大成
  // 3×(90s+backoff) 的纯等待,拿不到任何数据。只有真网络错误才重试。
  const backoff = [1000, 2000];
  let lastErr = null;

  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
          // 保持 timeoutMs:慢端点 401 重取后若退回默认 25s,会把常态 59s 的
          // 响应误判成故障。
          return ztFetch(pathAndQuery, { allowRefresh: false, timeoutMs });
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
      // undici 在 DNS/连接重置/TLS 失败时抛裸 TypeError: fetch failed,真实 code 在 e.cause。
      // 旧白名单只认 ECONNREFUSED/ETIMEDOUT/AbortError,会漏判这类瞬时抖动,导致整轮采集全部失败、日报归零。
      // (backport 自 tencent-vm 线上热修,2026-07-22 部署 V4 时回传)
      const causeCode = e.cause && e.cause.code;
      const retryableCodes = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE'];
      // 2026-07-27: AbortError(本地超时)移出重试白名单。禅道慢端点响应 11-59s,
      // 超时重试的每一次都会再等满 timeoutMs 才失败,把"慢"放大成"全灭":
      // 20:20 那轮 3 个 exec 各烧 48s(3×15s+backoff) 后 rawTasks=0 → exit 2。
      // 该慢的端点给足超时即可,重试无收益。
      // undici 在不同 node 版本下可能把 abort 包成 TypeError: fetch failed
      // 并把 AbortError 塞进 cause,所以两层都要认,否则"超时不重试"会漏。
      const isAbort = e.name === 'AbortError' || (e.cause && e.cause.name === 'AbortError');
      const isNetwork = !isAbort && (
        retryableCodes.includes(e.code) ||
        retryableCodes.includes(causeCode) ||
        (typeof causeCode === 'string' && causeCode.startsWith('UND_ERR')) ||
        e.message === 'fetch failed');
      if (isNetwork && attempt < backoff.length) {
        await sleep(backoff[attempt]);
        continue;
      }
      // 保留 e.cause 的真实原因,避免日志里只剩无信息量的 "fetch failed"。
      const detail = causeCode || (e.cause && e.cause.message) || e.code;
      const reason = detail ? e.message + ' (' + detail + ')' : e.message;
      return { ok: false, status: 0, body: null, reason: sanitizeMessage(reason) };
    }
  }
  return { ok: false, status: 0, body: null, reason: lastErr ? sanitizeMessage(lastErr.message) : 'unknown' };
}

async function ztPaginate(basePath, listKey) {
  // basePath like '/products/95/bugs?status=all'
  // listKey: explicit field name to read items from (avoid heuristic-induced confusion).
  const sep = basePath.includes('?') ? '&' : '?';
  // 2026-05-13: unified page size shrunk from 500 to 100. Zentao on this
  // instance gets visibly slower as the SQL row scan/sort cost grows with
  // limit (observed 4-24s wall variance at limit=500 vs ~3s at limit=100
  // against /products/95/bugs?status=all). Smaller pages mean more round
  // trips for large endpoints, but each one is far more reliable; we'd
  // rather take MAX_PAGES=20 round trips than gamble on one big one.
  const limit = 100;
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
async function fetchClosedTodayStories(productId, date, opts = {}) {
  const { fetchFn = ztFetch, attempts = 2, state = STATE } = opts;
  const url = `/products/${productId}/stories?status=closedstory&order=closedDate_desc&limit=100&page=1`;
  // 2026-05-12: fallback to full paginate burns 200-400s pulling 540+ rows
  // to match 0-5 today-closed entries — net zero ROI when Zentao is slow.
  // 该结论只否定"全量分页 fallback",不否定重试同一条轻量查询。
  //
  // 2026-07-27:原实现失败即静默返回 [] 且不记 skipped —— 日报"今日完成需求"
  // 会无声归零,读者看到的是"今天没完成任何需求"这个**错误断言**,比不发日报
  // 更糟。改为:重试一次(成本仅一次调用);仍失败则记入 skipped 走 fatal 路径,
  // 让流程停在"不发"而不是"发错"。
  let r = null;
  for (let i = 0; i < attempts; i++) {
    r = await fetchFn(url);
    if (r.ok) break;
    if (i < attempts - 1) trace(`closedToday stories fetch failed (${r.reason}); retry ${i + 2}/${attempts}`);
  }
  if (!r.ok) {
    trace(`closedToday stories fetch failed after ${attempts} attempts (${r.reason}); marking skipped (critical)`);
    state.skipped.push({
      path: '/products/*/stories',
      page: 1,
      queryParam: 'status=closedstory&order=closedDate_desc',
      reason: r.reason,
    });
    return [];
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
async function fetchTodayClosedBugs(productId, date, opts = {}) {
  const { fetchFn = ztFetch, attempts = 2 } = opts;
  const url = `/products/${productId}/bugs?status=all&order=closedDate_desc&limit=100&page=1`;
  // 2026-07-27:与 fetchClosedTodayStories 同样加一次重试(轻量单调用),
  // 失败仍返回 null,由 fetchBugsInScope 记 skipped 使其可见。
  let r = null;
  for (let i = 0; i < attempts; i++) {
    r = await fetchFn(url);
    if (r.ok) break;
    if (i < attempts - 1) trace(`bugs closed-today fetch failed (${r.reason}); retry ${i + 2}/${attempts}`);
  }
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

// 2026-05-13: scoped per-execution task fetch.
//
// Replaces the unfiltered /executions/{id}/tasks paginate (which on
// accumulator sprints like exec 2028 — 1576 cumulative tasks across 16
// pages × ~14s wall = 220s+) with three narrow order=...desc + client-side
// early-exit queries running in parallel.
//
// Same pattern as fetchClosedTodayStories / fetchTodayClosedBugs above:
// Zentao's server-side sort + a lookback cutoff lets us pull just the
// recently active tasks (typically <100 across a 30-day window) instead of
// every historical task ever created on the execution.
//
// Why three order-by-desc queries instead of one:
//   - openedDate_desc      → covers today-new + recently-opened in-flight tasks
//   - finishedDate_desc    → covers today-done + recently-finished tasks
//                            (Zentao clusters null finishedDate at the tail
//                            under this sort, so the first null marks end-of-window)
//   - lastEditedDate_desc  → catch-all for tasks edited recently but neither
//                            opened nor finished in the window (status flips,
//                            reassignment, comments)
//
// Union by task id deduplicates the typical overlap. Falls back to ok:false
// only when all three queries fail; partial failure (1-2 of 3) still returns
// a usable union with reduced coverage logged in STATE.skipped.
//
// 2026-05-13 probe evidence (status= filters NOT used here):
//   /executions/2028/tasks?status=doing             → total=7  but tasks[]=4 (raw-window post-filter quirk)
//   /executions/2028/tasks?order=openedDate_desc    → server-sort honored, page1 starts with today
//   /executions/2028/tasks?order=finishedDate_desc  → null clusters at tail (confirmed)
async function fetchExecutionTasksScoped(execId, date, opts = {}) {
  const {
    lookbackDays = 30,
    fetchFn = ztFetch,
    maxPages = 3,
    // 2026-07-27: 该端点是全流程最慢的一个(实测 11.5-59.3s/调用),必须用
    // 独立的长超时,否则默认 25s 会把常态响应误判成故障。
    reqTimeoutMs = SLOW_REQ_TIMEOUT_MS,
  } = opts;
  const fetchSlow = (url) => fetchFn(url, { timeoutMs: reqTimeoutMs });

  const lookback = new Date(`${date}T00:00:00Z`);
  lookback.setUTCDate(lookback.getUTCDate() - lookbackDays);
  const threshold = lookback.toISOString().slice(0, 10);

  const base = `/executions/${execId}/tasks`;
  const sanitizedPath = '/executions/*/tasks';

  const fetchScoped = async (queryParam, dateField, { skipNullEarly, preloadedPage1 }) => {
    const items = [];
    let reachedEnd = false;
    for (let page = 1; page <= maxPages && !reachedEnd; page++) {
      let rows;
      if (page === 1 && preloadedPage1) {
        rows = preloadedPage1;
      } else {
        const url = `${base}?${queryParam}&limit=100&page=${page}`;
        const r = await fetchSlow(url);
        if (!r.ok) {
          STATE.skipped.push({ path: sanitizedPath, page, queryParam, execId, reason: r.reason });
          return { ok: false, items };
        }
        rows = r.body.tasks || [];
      }
      if (rows.length === 0) break;
      for (const t of rows) {
        const v = t[dateField];
        if (!v || String(v).startsWith('0000-')) {
          if (skipNullEarly) {
            reachedEnd = true;
            break;
          }
          continue;
        }
        const day = String(v).slice(0, 10);
        if (day < threshold) {
          reachedEnd = true;
          break;
        }
        items.push(t);
      }
      if (rows.length < 100) break;
    }
    return { ok: true, items };
  };

  // 2026-07-23 自适应探针:先发 1 次 lastEditedDate_desc page1。响应 total
  // 为数字且首页已取齐(含 total=0 空迭代)→ 全部任务在手,客户端按三个
  // 日期字段本地过滤,单次调用完成——覆盖 b7e92e6 executions 取齐后暴露
  // 的 ~85 个无近期活动陈年迭代(此前每个固定烧 3 次排序查询,晚间禅道
  // 单调用 3-4s 时 phase2 必撞 900s 硬超时)。大迭代/无 total 响应回退
  // 既有 3 腿路径,探针结果复用为 lastEditedDate 腿 page1,零额外开销。
  // 注意:不允许按 execution.status/end 上游过滤——exec 2028 实测
  // status=doing、end=2024-08-31,两个字段都会误杀核心班牛 sprint。
  const probe = await fetchSlow(`${base}?order=lastEditedDate_desc&limit=100&page=1`);
  let probeRows = null;
  let probeFailedResult = null;
  if (!probe.ok) {
    STATE.skipped.push({
      path: sanitizedPath, page: 1, queryParam: 'order=lastEditedDate_desc', execId, reason: probe.reason,
    });
    probeFailedResult = { ok: false, items: [] };
  } else {
    probeRows = probe.body.tasks || [];
    const total = typeof probe.body.total === 'number' ? probe.body.total : null;
    if (total !== null && probeRows.length >= total) {
      const items = probeRows.filter((t) =>
        [t.openedDate, t.finishedDate, t.lastEditedDate].some((v) => {
          if (!v || String(v).startsWith('0000-')) return false;
          return String(v).slice(0, 10) >= threshold;
        }));
      return { ok: true, items };
    }
  }

  const results = await Promise.all([
    fetchScoped('order=openedDate_desc', 'openedDate', { skipNullEarly: false }),
    fetchScoped('order=finishedDate_desc', 'finishedDate', { skipNullEarly: true }),
    probeFailedResult !== null
      ? Promise.resolve(probeFailedResult)
      : fetchScoped('order=lastEditedDate_desc', 'lastEditedDate', { skipNullEarly: false, preloadedPage1: probeRows }),
  ]);

  if (results.every((r) => !r.ok)) {
    return { ok: false, items: [] };
  }

  const byId = new Map();
  for (const r of results) {
    for (const t of r.items) {
      if (!byId.has(t.id)) byId.set(t.id, t);
    }
  }
  return { ok: true, items: Array.from(byId.values()) };
}

// ---- phase2: execution → tasks ------------------------------------------

// phase2 结束后留给下游(派生/写文件)的余量。
const PHASE2_BUDGET_RESERVE_MS = 60_000;
// 2026-07-27:并发 3 → 1。实测同一禅道实例上 /executions/{id}/tasks 并发会
// 自我拖慢:串行 13.7s 的调用在 3 并发下变 25.1/36.2/>60s,三个源一起撞
// EXEC_TIMEOUT 全灭(rawTasks=0 → exit 2)。对照实验(仅放宽超时、保留并发 3)
// 仍然丢掉 exec 3436;串行版同一时段 3 个 exec 全部取到(184s, exit 0)。
// 该端点服务端近乎串行处理,并发没有吞吐收益,只有超时风险。
const TASK_CONCURRENCY_DEFAULT = Math.max(
  1,
  parseInt(process.env.EXP_COMPASS_TASK_CONCURRENCY || '1', 10) || 1,
);
// 单个 execution 的墙钟上限。不再是死值:按"剩余预算 / 剩余 execution 数"
// 自适应,并 clamp 到 [MIN, MAX]。exec 少时给足(实测慢窗单 exec 需 67s),
// exec 多时自动收紧,保证永远不会因个别慢源吃光整轮预算。
const EXEC_TIMEOUT_MIN_MS = 60_000;
const EXEC_TIMEOUT_MAX_MS = parseInt(process.env.EXP_COMPASS_EXEC_TIMEOUT_MS || '240000', 10);

function pickExecTimeoutMs(remainingMs, remainingExecs, minMs = EXEC_TIMEOUT_MIN_MS, maxMs = EXEC_TIMEOUT_MAX_MS) {
  const per = Math.floor(remainingMs / Math.max(1, remainingExecs));
  return Math.min(maxMs, Math.max(minMs, per));
}

// 把某个 execution 在 STATE.skipped 里留下的所有痕迹抹掉(重试成功后调用)。
// fetchExecutionTasksScoped 内部按 page/queryParam 逐条 push,外层按 exec
// push 汇总条目,两种都要清,否则重试成功了 finalizeOutput 仍判 fatal。
function dropExecSkips(state, execId) {
  const id = Number(execId);
  state.skipped = state.skipped.filter((s) => {
    if (s.path !== '/executions/*/tasks') return true;
    if (Number(s.execId) === id) return false;
    if (Array.isArray(s.executions) && s.executions.length === 1 && Number(s.executions[0]) === id) return false;
    return true;
  });
}

// phase2 主循环。2026-05-13 起每个 execution 独立 race 自己的超时(慢源只丢
// 自己,兄弟源保留);2026-07-27 起并发默认降到 1、超时自适应,并在首轮结束后
// 用剩余预算对失败源做一轮串行重试。
//
// 重试轮存在的理由:20:20 那次整轮硬预算 900s 只用了 302s 就 exit 2 —— 600s
// 预算完全没用上,却让"禅道抖动 2 分钟"等价于"当天日报不发"。重试把瞬时抖动
// 变成可自愈,只有连续两次都失败才 fatal。
async function fetchAllExecutionTasks(allExecs, date, opts = {}) {
  const {
    vocOwnedExecutionIds = new Set(),
    fetchExecFn = fetchExecutionTasksScoped,
    concurrency = TASK_CONCURRENCY_DEFAULT,
    wallDeadlineMs = Infinity,
    startMs = TRACE_T0,
    nowFn = Date.now,
    traceFn = trace,
    state = STATE,
    execTimeoutMinMs = EXEC_TIMEOUT_MIN_MS,
    execTimeoutMaxMs = EXEC_TIMEOUT_MAX_MS,
    retryFailed = true,
  } = opts;

  // 2026-05-13: VOC-owned executions go first. If the wall-clock budget
  // ever runs out, non-VOC sprints (cross-team borrows) get sacrificed
  // before the core daily-report data.
  const sorted = [...allExecs].sort((a, b) => {
    const av = vocOwnedExecutionIds.has(Number(a.id)) ? 0 : 1;
    const bv = vocOwnedExecutionIds.has(Number(b.id)) ? 0 : 1;
    return av - bv;
  });

  const EXEC_TIMEOUT_SENTINEL = Symbol('exec-timeout');
  const rawTasks = [];
  const failedExecIds = [];
  let wallClockEarlyExit = false;

  const raceOne = async (execId, timeoutMs) => {
    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve(EXEC_TIMEOUT_SENTINEL), timeoutMs);
    });
    try {
      return await Promise.race([fetchExecFn(execId, date), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  for (let i = 0; i < sorted.length; i += concurrency) {
    const elapsedMs = nowFn() - startMs;
    if (elapsedMs > wallDeadlineMs) {
      const remaining = sorted.length - i;
      traceFn(`WARN: wall-clock budget exhausted at ${(elapsedMs / 1000).toFixed(1)}s; skipping ${remaining} executions to leave ${PHASE2_BUDGET_RESERVE_MS / 1000}s for downstream`);
      state.skipped.push({
        path: '/executions/*/tasks',
        reason: 'wall-clock-budget',
        remaining,
        // 2026-07-23: 记录被砍 execution id,fatal 判定需区分 VOC/非 VOC
        executions: sorted.slice(i).map((e) => Number(e.id)),
      });
      wallClockEarlyExit = true;
      break;
    }
    const batch = sorted.slice(i, i + concurrency);
    // 首轮不把预算一次分完:留一半给重试轮,慢源第二次通常就过了。
    const execTimeoutMs = pickExecTimeoutMs(
      (wallDeadlineMs - elapsedMs) / 2,
      Math.ceil((sorted.length - i) / concurrency),
      execTimeoutMinMs,
      execTimeoutMaxMs,
    );
    traceFn(`fetch executions batch start [${batch.map((e) => e.id).join(',')}] timeout=${(execTimeoutMs / 1000).toFixed(0)}s`);
    const batchResults = await Promise.all(
      batch.map(async (ex) => ({ id: ex.id, result: await raceOne(ex.id, execTimeoutMs) })),
    );
    for (const { id, result } of batchResults) {
      if (result === EXEC_TIMEOUT_SENTINEL) {
        traceFn(`WARN: execution=${id} exceeded ${(execTimeoutMs / 1000).toFixed(0)}s; skipping`);
        state.skipped.push({ path: '/executions/*/tasks', reason: 'exec-timeout', executions: [id] });
        failedExecIds.push(Number(id));
        continue;
      }
      if (!result.ok) {
        traceFn(`WARN: execution=${id} all scoped task queries failed; skipping`);
        state.skipped.push({ path: '/executions/*/tasks', reason: 'scoped-fetch-failed', executions: [id] });
        failedExecIds.push(Number(id));
        continue;
      }
      traceFn(`fetch execution=${id} tasks done (${result.items.length})`);
      rawTasks.push(...result.items);
    }
  }

  // 重试轮:串行、逐个用剩余预算重跑首轮失败的 execution。
  const retriedOk = [];
  if (retryFailed && failedExecIds.length && !wallClockEarlyExit) {
    for (let k = 0; k < failedExecIds.length; k++) {
      const remainingMs = wallDeadlineMs - (nowFn() - startMs);
      if (remainingMs < execTimeoutMinMs) {
        traceFn(`WARN: no budget left for retrying ${failedExecIds.length - k} failed execution(s)`);
        break;
      }
      const execId = failedExecIds[k];
      const timeoutMs = pickExecTimeoutMs(remainingMs, failedExecIds.length - k, execTimeoutMinMs, execTimeoutMaxMs);
      traceFn(`retry execution=${execId} (timeout=${(timeoutMs / 1000).toFixed(0)}s, budget left ${(remainingMs / 1000).toFixed(0)}s)`);
      // 先清首轮痕迹再重跑,这样无论成败 skipped 里都只留最新一次的结论,
      // 不会因两轮各 push 一遍而重复计数。
      dropExecSkips(state, execId);
      const result = await raceOne(execId, timeoutMs);
      if (result !== EXEC_TIMEOUT_SENTINEL && result.ok) {
        // fetchExecutionTasksScoped 内部可能在部分腿失败时留下 page 级记录,
        // 整体 ok 的情况下这些是可容忍的降级,不该阻断 → 一并清掉。
        dropExecSkips(state, execId);
        rawTasks.push(...result.items);
        retriedOk.push(execId);
        traceFn(`retry execution=${execId} ok (${result.items.length} tasks)`);
      } else {
        dropExecSkips(state, execId);
        state.skipped.push({
          path: '/executions/*/tasks',
          reason: result === EXEC_TIMEOUT_SENTINEL ? 'exec-timeout' : 'scoped-fetch-failed',
          executions: [Number(execId)],
        });
        traceFn(`retry execution=${execId} failed again; keeping it skipped`);
      }
    }
  }

  return { rawTasks, wallClockEarlyExit, failedExecIds, retriedOk };
}

// 2026-07-24 V5: 查白名单项目的 executions,构建 vocOwnedExecutionIds
// (loose task 判定用)。同时记录 looseBackfillProjectId 下 status=doing 的
// exec → looseBackfillExecs(candidate 兜底,防某 VOC 日常 exec 无 story 关联
// 导致其 loose task 漏)。project exec 列表查询失败时 ztPaginate 会自行
// push STATE.skipped(page1 失败),path=/projects/*/executions 为 critical。
async function fetchVocOwnedExecutions(vocProjectIds, looseBackfillProjectId, opts = {}) {
  const { paginateFn = ztPaginate } = opts;
  // 2026-07-24: looseBackfillProjectId 与 vocProjectIds 是各自独立可覆盖的 env,
  // 若前者不在后者白名单内,下面的 pid === looseBackfillProjectId 恒为 false,
  // looseBackfillExecs 恒空、loose 散活兜底全漏且无任何报错——只能靠这条 trace 发现。
  if (![...vocProjectIds].map(Number).includes(Number(looseBackfillProjectId))) {
    trace(`WARN: looseBackfillProjectId=${looseBackfillProjectId} not in vocProjectIds whitelist; loose backfill will be empty`);
  }
  const vocOwnedExecutionIds = new Set();
  const looseBackfillExecs = new Set();
  const results = await Promise.all(
    [...vocProjectIds].map(async (pid) => ({
      pid: Number(pid),
      execs: await paginateFn(`/projects/${pid}/executions`, 'executions'),
    })),
  );
  for (const { pid, execs } of results) {
    for (const ex of execs) {
      vocOwnedExecutionIds.add(Number(ex.id));
      if (pid === Number(looseBackfillProjectId) && ex.status === 'doing') {
        looseBackfillExecs.add(Number(ex.id));
      }
    }
  }
  return { vocOwnedExecutionIds, looseBackfillExecs };
}

// 2026-07-24 V5 核心:从 in-scope story 反查其关联的 execution 全集。
// /stories/{id} 详情返回 executions map(key=exec id),用户确认研发会显式
// "关联需求到迭代",故该 map 完备覆盖承载此 story task 的所有 exec。
// 任一 story 详情失败 → ok=false + critical skipped(该 story 的 attached
// task 可能漏,宁 fatal 不广播残报)。并发分批,复用 ztFetch 的重试/401 刷新。
async function fetchStoryExecutionIds(storyIds, opts = {}) {
  const { fetchFn = ztFetch, concurrency = 6 } = opts;
  const step = Math.max(1, concurrency); // concurrency<=0 会死循环,兜底步进为 1
  const execIds = new Set();
  let anyFailed = false;
  for (let i = 0; i < storyIds.length; i += step) {
    const batch = storyIds.slice(i, i + step);
    const results = await Promise.all(batch.map((sid) => fetchFn(`/stories/${sid}`)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (!r.ok) {
        STATE.skipped.push({ path: '/stories/*', storyId: batch[j], reason: r.reason });
        anyFailed = true;
        continue;
      }
      const execs = (r.body && r.body.executions) || {};
      for (const k of Object.keys(execs)) execIds.add(Number(k));
    }
  }
  return { ok: !anyFailed, execIds };
}

async function fetchBugsInScope(productId, date, opts = {}) {
  const { paginateFn = ztPaginate, closedTodayFn = fetchTodayClosedBugs, state = STATE } = opts;
  const [unclosed, closedTodayMaybe] = await Promise.all([
    paginateFn(`/products/${productId}/bugs?status=unclosed`, 'bugs'),
    closedTodayFn(productId, date),
  ]);
  if (closedTodayMaybe === null) {
    // 2026-05-12: same reasoning as fetchClosedTodayStories. Full paginate on
    // ?status=all is the longest single operation against this Zentao
    // (1100+ rows, 3 pages of 500); when the fast-path already failed under
    // load, fanning out a heavier query on the same backend is a guaranteed
    // hard-timeout path — 该结论仍然成立,**不做**全量 fallback。
    //
    // 2026-07-27:但"不 fallback"不等于"可以静默"。原实现直接 return unclosed,
    // 日报"今日完成 Bug"无声归零(2026-07-27 实跑:bugs 9 → 3,今日关闭的 6 条
    // 全丢且 exit 0)。改为记 skipped 走 fatal —— 宁可不发,不可发错。
    trace('bugs closed-today fetch failed after retry; marking skipped (critical)');
    state.skipped.push({
      path: '/products/*/bugs',
      page: 1,
      queryParam: 'status=all&order=closedDate_desc',
      reason: 'closed-today-fetch-failed',
    });
    return unclosed;
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

// 整天差:date(YYYY-MM-DD) − iso 的日期部分,负数截断为 0。
// V4 派生 overdue_days / resolved_age_days / stale_days 共用。
function daysBetween(date, iso) {
  if (!iso) return 0;
  const a = Date.parse(`${date}T00:00:00Z`);
  const b = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((a - b) / 86400000));
}

// 新增 Bug 段的创建人显示:机器人录入时换显 assignedTo(V4,设计文档 B5)。
const ROBOT_ACCOUNTS = ['bug录入机器人'];

// 禅道 Web 端 base(去掉 /api.php/v1 尾巴),bug.url 跟踪链接用。
function zentaoWebBase() {
  return String(process.env.ZENTAO_BASE_URL || '').replace(/\/api\.php.*$/, '');
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

// progress 三级口径:工时 → 任务计数 → 阶段估值。
// 工时口径盲区(2026-07-22 实证 S22290):未完成任务没填预估(consumed+left=0)
// 时完全不进分母,doing 任务没填 left 被当作已消耗完——5 任务 1 完成算出
// 100%。因此工时口径仅在「所有未完成任务都有工时数据」时可信;否则降级为
// 任务计数口径 done_leaf/total_leaf(source='任务');无任务再回退阶段估值。
function computeProgress(taskList, stage) {
  let consumed = 0, left = 0, hasHours = false;
  let unfinishedNoHours = false;
  for (const t of taskList) {
    const c = Number(t.consumed || 0);
    const l = Number(t.left || 0);
    if (c + l > 0) hasHours = true;
    if (c + l === 0 && !TASK_DONE_STATUSES.includes(t.status)) unfinishedNoHours = true;
    consumed += c;
    left += l;
  }
  if (hasHours && consumed + left > 0 && !unfinishedNoHours) {
    return { progress_pct: Math.round((consumed / (consumed + left)) * 100), progress_source: '工时' };
  }
  if (taskList.length > 0) {
    const done = taskList.filter((t) => TASK_DONE_STATUSES.includes(t.status)).length;
    return { progress_pct: Math.round((done / taskList.length) * 100), progress_source: '任务' };
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
    execution: Number(t.execution || 0),
    parent: Number(t.parent || 0),
    status,
    status_cn: STATUS_CN[status] || status,
    assignedTo,
    finishedBy,
    openedBy: pickName(t.openedBy),
    display_handler: isDone ? (finishedBy || assignedTo) : (assignedTo || finishedBy),
    deadline,
    is_overdue: isOverdue,
    overdue_days: isOverdue ? daysBetween(date, deadline) : 0,
    is_normal: !isOverdue,
    consumed: Number(t.consumed || 0),
    left: Number(t.left || 0),
    is_today_created: startsWithDate(t.openedDate, date),
    is_today_finished: startsWithDate(t.finishedDate, date),
    openedDate: t.openedDate || null,
    finishedDate: t.finishedDate || null,
  };
}

// display_title:去开头【…】前缀(客服录入的日期戳)、trim、超 40 字截断加 …(V4,B4)
function cleanBugTitle(title) {
  let t = String(title || '');
  t = t.replace(/^(?:\s*【[^】]*】)+\s*/, '').trim();
  const chars = Array.from(t);
  if (chars.length > 40) t = chars.slice(0, 40).join('') + '…';
  return t;
}

function deriveBug(b, date) {
  const status = b.status || 'active';
  const resolvedBy = pickName(b.resolvedBy);
  const closedBy = pickName(b.closedBy);
  const openedBy = pickName(b.openedBy);
  const assignedTo = pickName(b.assignedTo);
  // display_reporter:机器人录入且有真人 assignedTo 时换显执行侧(V4,B5)。
  // assignedTo 也是机器人时回退 openedBy(2026-07-22 回放实证 B56899,
  // 否则产出"bug录入机器人·机器人录入")。
  const displayReporter = ROBOT_ACCOUNTS.includes(openedBy)
      && assignedTo && !ROBOT_ACCOUNTS.includes(assignedTo)
    ? `${assignedTo}·机器人录入`
    : openedBy;
  // display_handlers: ordered, deduplicated list of "who acted on this bug".
  // Used by AI when rendering the "修复 Bug" section to show all relevant handlers
  // (resolver + closer) instead of picking just one.
  const handlers = [];
  if (resolvedBy) handlers.push(resolvedBy);
  if (closedBy && !handlers.includes(closedBy)) handlers.push(closedBy);
  return {
    id: b.id,
    title: b.title,
    display_title: cleanBugTitle(b.title),
    url: `${zentaoWebBase()}/bug-view-${b.id}.html`,
    status,
    status_cn: status === 'active' ? '待处理'
      : status === 'resolved' ? '已解决待验'
      : status === 'closed' ? '已关闭'
      : status,
    severity: Number(b.severity || 0),
    openedBy,
    display_reporter: displayReporter,
    openedDate: b.openedDate || null,
    resolvedBy,
    resolvedDate: b.resolvedDate || null,
    closedBy,
    closedDate: b.closedDate || null,
    assignedTo,
    display_handlers: handlers,
    // resolved_age_days:已解决待验挂了几天(V4,存量风险·待验收超期)
    resolved_age_days: status === 'resolved' ? daysBetween(date, b.resolvedDate) : 0,
    is_today_opened: startsWithDate(b.openedDate, date),
    is_today_resolved: startsWithDate(b.resolvedDate, date),
    is_today_closed: startsWithDate(b.closedDate, date),
  };
}

function deriveStory(s, tasksOfStory, date) {
  const stage = s.stage || 'wait';
  const closedDate = s.closedDate && s.closedDate !== '0000-00-00 00:00:00' ? s.closedDate : null;
  // story.is_today_done — V4 拓宽(设计文档 E4):
  //   stage=closed → closedDate 当天(原信号保留)
  //   stage=released/verified → closedDate 常为空,用 lastEditedDate 当天近似
  //     "今日发布/验收"。V2 曾因 lastEditedDate 噪音弃用,V4 重启的差别是仅
  //     对 released/verified 生效(本团队极少用这两个 stage,噪音面可控),
  //     closed 仍锚定 closedDate。
  const isTodayDone = STAGE_DONE.includes(stage)
    && (startsWithDate(closedDate, date)
      || (stage !== 'closed' && startsWithDate(s.lastEditedDate, date)));

  // progress is computed only over leaf tasks of this story.
  const leaves = tasksOfStory.filter((t) => !tasksOfStory.some((c) => c.parent === t.id));
  const prog = computeProgress(leaves, stage);

  // ---- V4 活跃度派生(设计文档 §6) ----
  // is_active:developing 恒活跃;developed/tested 需「当日任务动态 ∨ 未完成
  // 任务 ∨ 逾期」;其余 stage 一律 false(不进需求推进段)。
  const hasLiveSignal = tasksOfStory.some((t) => t.is_today_created
    || t.is_today_finished
    || t.status === 'doing'
    || TASK_TODO_STATUSES.includes(t.status)
    || t.is_overdue);
  const isActive = stage === 'developing'
    ? true
    : (stage === 'developed' || stage === 'tested') ? hasLiveSignal : false;

  // last_activity_date:max(任务完成/创建时间 ∪ story 创建时间),滞留天数的锚点
  let lastActivity = s.openedDate || null;
  for (const t of tasksOfStory) {
    for (const d of [t.finishedDate, t.openedDate]) {
      if (d && (!lastActivity || Date.parse(d) > Date.parse(lastActivity))) lastActivity = d;
    }
  }

  // is_today_tested:禅道拿不到 stage 变更时间,用「测试任务当日完成」近似
  // "今日测试完毕"(设计文档 §10 开放问题 1)。
  const isTodayTested = stage === 'tested'
    && tasksOfStory.some((t) => t.type === 'test' && t.is_today_finished);

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
    is_active: isActive,
    last_activity_date: lastActivity,
    stale_days: daysBetween(date, lastActivity),
    is_today_tested: isTodayTested,
    tasks: tasksOfStory,
  };
}

// ---- main collection ----------------------------------------------------

async function fetchProductName(productId) {
  // Earlier versions tried user.json (cached by zentao-api side-effect) as a
  // shortcut, but profile.view.products there is a CSV string of accessible
  // product IDs (e.g. "44,48,...,95,..."), NOT a {id: name} map. Indexing it
  // by productId returned a single character and quietly polluted the report
  // with name="1". /products/{id} on this Zentao returns {id, name, code, ...}
  // and the call already piggybacks on phase1's Promise.all fan-out, so the
  // wall-clock cost is effectively zero.
  const r = await ztFetch(`/products/${productId}`);
  if (r.ok && r.body && r.body.name) return r.body.name;
  return `Product-${productId}`;
}

function inScopeStory(s, date) {
  const stage = s.stage || 'wait';
  if (STAGE_IN_PROGRESS.includes(stage) || STAGE_TODO.includes(stage)) return true;
  // Closed: today-closed only. Released/verified: closedDate 常为空,补
  // lastEditedDate 当天(V4 拓宽,与 deriveStory.is_today_done 同口径)。
  if (STAGE_DONE.includes(stage)) {
    return startsWithDate(s.closedDate, date)
      || (stage !== 'closed' && startsWithDate(s.lastEditedDate, date));
  }
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
      // V4:进行中拆 活跃/滞留(active + stale == in_progress),概览需求行
      // 渲染 `{active} (另滞留 {stale})`。
      active: cntStory((s) => STAGE_IN_PROGRESS.includes(s.stage) && s.is_active),
      stale: cntStory((s) => STAGE_IN_PROGRESS.includes(s.stage) && !s.is_active),
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
      // V4 重映射(设计文档 A2):进行中=修复中(active)、待处理=已解决待验
      // (resolved)。V3 的映射与需求/任务行同名列语义相反,读者按字面必错。
      // 概览表下配脚注「ℹ️ BUG 行口径:…」。
      in_progress: cntBug((b) => b.status === 'active'),
      today_new: cntBug((b) => b.is_today_opened),
      today_done: cntBug((b) => b.is_today_closed),
      todo: cntBug((b) => b.status === 'resolved'),
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
// EXP_COMPASS_HARD_TIMEOUT_MS for tests or one-off cron tuning. Clamped to
// [60s, 30min] so a stray 0 / negative / NaN env doesn't make the script
// self-destruct on startup, and a too-large value can't blow past the
// cron 1800s cap.
// 2026-07-23: 10min → 15min。executions 取齐后 phase2 87→112 个,禅道慢
// 时段实测 phase2 需 ~650s(578s 时仍剩 7 个),600s 必撞 wall-clock。
// cron 总超时 1800s,collect 900s + AI 写作/自检/push ~700s 仍有余量。
const DEFAULT_HARD_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_HARD_TIMEOUT_MS = 60_000;
const MAX_HARD_TIMEOUT_MS = 30 * 60 * 1000;
const rawHardTimeoutMs = parseInt(process.env.EXP_COMPASS_HARD_TIMEOUT_MS || '', 10);
const HARD_TIMEOUT_MS = Number.isFinite(rawHardTimeoutMs)
  ? Math.min(Math.max(rawHardTimeoutMs, MIN_HARD_TIMEOUT_MS), MAX_HARD_TIMEOUT_MS)
  : DEFAULT_HARD_TIMEOUT_MS;
const _hardKill = setTimeout(() => {
  console.error(`FATAL: hard timeout (${HARD_TIMEOUT_MS}ms) reached, aborting`);
  process.exit(4);
}, HARD_TIMEOUT_MS);
_hardKill.unref();

// phase1 提前止损(2026-07-22 下午实证):禅道服务端抖动日 phase1 从常态
// ~35s 涨到 323s,吃掉 wall-clock 预算一半后 phase2 的 87 个 executions
// 注定跑不完(5 source skip → exit 2),不如在 phase1 结束时就 FATAL,
// 省下白耗的 ~5 分钟。
//
// 2026-07-27 改判据:原规则是"phase1 > 硬超时的 30%"。它的隐含前提——
// phase2 要遍历 87 个 execution——已被 V5 story-driven 重构消除(现在只有
// 3 个 exec,实测 phase2 113s)。固定比例于是变成误杀:本次实跑 phase1 317s
// 但数据完整、剩余 583s 预算足够 phase2 跑完 3 次,却被判死 exit 5。
// 新判据直接问真正的约束——**剩下的时间够不够 phase2 跑完**。
// PHASE2_MIN_NEEDED_MS 覆盖 story 反查(~80s) + 串行 exec(~120s) + 重试轮余量。
const PHASE2_MIN_NEEDED_MS = 240_000;
function phase1BudgetExceeded(tPhase1Ms, hardTimeoutMs, minNeededMs = PHASE2_MIN_NEEDED_MS) {
  return hardTimeoutMs - tPhase1Ms < minNeededMs;
}

// 落盘物理断路(2026-07-22 seq 83 事件):skipped>0 时 JSON 只写
// `${out}.partial` 并删除正式路径旧文件。此前 partial JSON 写正式路径
// "供诊断",结果 AI 无视 exit=2 直接读它把错误日报广播了出去;正式
// 路径不存在时 Step 2+ 物理上跑不起来,不再依赖提示词约束。
function finalizeOutput({ out, json, skippedCount }) {
  const target = skippedCount > 0 ? `${out}.partial` : out;
  fs.writeFileSync(target, json);
  fs.chmodSync(target, 0o600);
  if (skippedCount > 0) {
    try {
      fs.unlinkSync(out); // 防止残留的上一次完整 JSON 被后续步骤误用
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return target;
}

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

  // Phase 1: kick off the five independent root endpoints in parallel. They
  // share no data dependency, so the wall-clock cost collapses from
  // sum(loadUserMap, productName, activeStories, closedStories, bugs) to
  // max(...). Each ztPaginate now also fans out its own page-2+ requests
  // internally (see ztPaginate), so total in-flight fan-out can reach ~5
  // endpoints × up to 4 pages each — Zentao tolerates this in testing, and
  // the 30s per-request timeout still bounds the worst case.
  // 2026-07-24 V5: `/products/{id}/projects` 查询移除,project→execution
  // 遍历改由 phase2 story-driven 反查取代(见下方 phase2 注释)。
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
  ] = await Promise.all([
    loadUserMap(),
    fetchProductName(args.product),
    ztPaginate(`/products/${args.product}/stories`, 'stories'),
    fetchClosedTodayStories(args.product, args.date),
    fetchBugsInScope(args.product, args.date),
  ]);
  const tPhase1Ms = Date.now() - tPhase1Start;
  trace(`phase1 done in ${tPhase1Ms}ms: users=${USER_MAP.size} product=${productName} active=${activeStories.length} closedToday=${closedToday.length} bugs=${rawBugs.length}`);

  // 禅道抖动日提前止损:phase1 超预算说明服务端整体变慢,phase2 注定
  // 跑不完,与其耗满硬超时再 exit 2,不如现在就 FATAL(exit 5)。
  if (phase1BudgetExceeded(tPhase1Ms, HARD_TIMEOUT_MS)) {
    console.error(
      `FATAL: phase1 took ${tPhase1Ms}ms, only ${HARD_TIMEOUT_MS - tPhase1Ms}ms left ` +
      `(< ${PHASE2_MIN_NEEDED_MS}ms needed for phase2) — Zentao too slow, aborting before phase2`
    );
    process.exit(5);
  }

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
  // "not found") — must go through /executions/{eid}/tasks. The exact execution
  // id set is resolved via story-driven reverse lookup (see 2026-07-24 V5
  // comment below), not by traversing every project under the product.
  //
  // Wall-clock budget: the per-execution tasks fan-out below can still take
  // minutes against a slow Zentao, and we'd rather emit a partial JSON than be
  // SIGKILLed by the hard timeout mid-write. Reserve BUDGET_RESERVE_MS for the
  // downstream merge / derive / writeFile path; once the elapsed time crosses
  // (HARD_TIMEOUT - reserve), stop enqueueing new batches, mark the JSON
  // degraded, and let main finish.
  // Resolve VOC-owned project whitelist (env override > default const)
  const vocProjectEnv = process.env.EXP_COMPASS_VOC_PROJECT_IDS || '';
  const vocOwnedProjectIds = new Set(
    (vocProjectEnv ? vocProjectEnv.split(',') : DEFAULT_VOC_OWNED_PROJECT_IDS.map(String))
      .map((s) => String(s).trim())
      .filter(Boolean)
      .map(Number),
  );
  // 2026-07-24 V5: phase2 查询方向反转(story-driven)。不再遍历 product 下
  // 全部 13 项目 112 exec(88% 空遍历);改为从 in-scope story 反查其关联
  // 的 execution 精确集合。见 20260724-体验罗盘日报-V5-设计文档。
  const looseBackfillProjectId = Number(
    process.env.EXP_COMPASS_LOOSE_BACKFILL_PROJECT_ID || DEFAULT_LOOSE_BACKFILL_PROJECT_ID,
  );
  const { vocOwnedExecutionIds, looseBackfillExecs } =
    await fetchVocOwnedExecutions(vocOwnedProjectIds, looseBackfillProjectId);
  trace(`VOC-owned executions: ${vocOwnedExecutionIds.size}; loose backfill: ${[...looseBackfillExecs].join(',') || '-'}`);

  const { ok: storyExecOk, execIds: storyExecIds } =
    await fetchStoryExecutionIds([...productStoryIds]);
  trace(`story-driven exec ids (${storyExecIds.size}): ${[...storyExecIds].sort((a, b) => a - b).join(',')}`);

  const candidateExecIds = new Set([...storyExecIds, ...looseBackfillExecs]);
  const allExecs = [...candidateExecIds].map((id) => ({ id }));
  trace(`total executions to fetch tasks: ${allExecs.length} (story ${storyExecIds.size} ∪ backfill ${looseBackfillExecs.size}); storyExecOk=${storyExecOk}`);

  const tPhase2Start = Date.now();
  const { rawTasks, wallClockEarlyExit } = await fetchAllExecutionTasks(allExecs, args.date, {
    vocOwnedExecutionIds,
    wallDeadlineMs: HARD_TIMEOUT_MS - PHASE2_BUDGET_RESERVE_MS,
  });
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
  // loose_tasks (2026-05-13): tasks without a VOC-scoped story attached, but
  // belonging to a VOC-owned execution. Previously this gate was storyID-based
  // (storyID===0 OR storyID in productStoryIds), which let any execution's
  // storyID=0 task through — e.g. T44099/T44098 (618 大促慢 SQL 优化) on
  // aPaaS_26_Q2 leaked into the VOC daily report. Switching to
  // execution-membership disambiguates: tasks under iPaaS / aPaaS / 基础引擎 /
  // 犇犇 executions need a VOC storyID to be kept; tasks under班牛 sprints
  // (regardless of story link) are VOC's own work.
  const looseTasks = tasksDerivedAll.filter(
    (t) => !scopedStoryIds.has(t.storyID)
      && vocOwnedExecutionIds.has(t.execution)
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

  // 2026-07-23: skip 条目按影响范围分流。exec 级条目(带 executions/execId)
  // 若涉及的 execution 全部非 VOC 白名单项目所属 → 非致命降级;产品级
  // 条目(users/stories/bugs 等,无 exec 标记)或涉及任一 VOC 迭代 → 致命。
  const isNonCriticalSkip = (s) => {
    const ids = Array.isArray(s.executions) && s.executions.length > 0
      ? s.executions.map(Number)
      : (s.execId !== undefined ? [Number(s.execId)] : null);
    if (!ids) return false;
    return ids.every((id) => !vocOwnedExecutionIds.has(id));
  };
  const criticalSkipped = STATE.skipped.filter((s) => !isNonCriticalSkip(s));
  const degradedSkipped = STATE.skipped.filter(isNonCriticalSkip);

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
      skipped: criticalSkipped,
      degraded_non_voc: degradedSkipped,
      budget_exceeded: STATE.budgetExceeded,
      wall_clock_early_exit: wallClockEarlyExit,
    },
  };

  payload = maybeDegrade(payload);

  // critical skipped 非空 = 有产品级数据源或 VOC 迭代数据整页丢失(如
  // bugs?status=unclosed 401 被跳过),JSON 结构合法但内容不完整。宁可不
  // 出报告也不广播错数据(2026-07-22 B57142 事件:active bug 全丢,概览
  // BUG 行 0/0 照播)。partial JSON 落 `${out}.partial` 且正式路径被清空
  // —— 物理断路,后续步骤读不到正式文件自然中止(2026-07-22 seq 83 事件:
  // AI 无视 exit=2 照播 partial)。
  //
  // 2026-07-23: 恢复 05-13「预算耗尽时牺牲非 VOC 借派迭代」的降级语义。
  // 7425d29 把所有 skip 一刀切 fatal,与 b7e92e6 executions 取齐叠加后,
  // 晚间禅道慢速时非 VOC 陈年迭代超时 → 整轮中止(07-23 晚三连败)。
  // 非 VOC exec 级 skip 不再 fatal:记入 _meta.degraded_non_voc 可见降级
  // (非静默),日报脚注可说明借派数据不全;产品级数据源与 VOC 迭代的
  // skip 仍然 fatal。
  const outTarget = finalizeOutput({
    out: args.out,
    json: JSON.stringify(payload, null, 2),
    skippedCount: criticalSkipped.length,
  });

  if (criticalSkipped.length > 0) {
    console.error(`FATAL: ${criticalSkipped.length} critical source(s) skipped — JSON incomplete (kept at ${outTarget} for diagnosis only), aborting to prevent silent data loss:`);
    for (const s of criticalSkipped) console.error(`  - ${s.path} page=${s.page} reason=${s.reason}`);
    process.exit(2);
  }

  if (degradedSkipped.length > 0) {
    for (const s of degradedSkipped) {
      trace(`WARN: non-VOC execution source degraded — ${s.path} reason=${s.reason} executions=${(s.executions || [s.execId]).join(',')}`);
    }
  }

  process.stdout.write(`OK product=${args.product} date=${args.date} api_calls=${STATE.apiCalls} stories=${stories.length} tasks=${allTasksForSummary.length} bugs=${bugs.length} degraded_non_voc=${degradedSkipped.length} → ${args.out}\n`);
}

if (require.main === module) {
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
} else {
  // Loaded via require() — typically a test. Cancel the hard-kill so we
  // don't sigterm the test process, and expose narrow surface for testing.
  clearTimeout(_hardKill);
  module.exports = {
    fetchExecutionTasksScoped, STATE,
    // HTTP 层(tests/run-ztfetch-timeout-tests.js):超时可配 + 超时不重试
    ztFetch, REQ_TIMEOUT_MS, SLOW_REQ_TIMEOUT_MS,
    // 今日完成需求/Bug(tests/run-closed-today-tests.js):失败重试 + 失败必须可见
    fetchClosedTodayStories, fetchTodayClosedBugs, fetchBugsInScope,
    // phase2 循环(tests/run-phase2-race-tests.js):并发/自适应超时/重试轮
    fetchAllExecutionTasks, pickExecTimeoutMs, dropExecSkips,
    TASK_CONCURRENCY_DEFAULT,
    // V5 story-driven 采集(tests/run-story-driven-tests.js)
    fetchVocOwnedExecutions, fetchStoryExecutionIds,
    // V4 派生函数(tests/run-derive-v4-tests.js)
    deriveTask, deriveBug, deriveStory, buildSummary, inScopeStory,
    // partial 防护(tests/run-partial-guard-tests.js)
    finalizeOutput, phase1BudgetExceeded,
  };
}
