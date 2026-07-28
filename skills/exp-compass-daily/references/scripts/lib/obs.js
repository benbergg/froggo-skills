'use strict';
// 采集可观测性:记录每次禅道请求,产出可跨运行对比的归因数据。
//
// 存在的理由(2026-07-27 事故复盘):当时定位根因靠的是运气——`[trace]` 只写
// stdout 被 openclaw session 吞掉,`_meta` 只在成功落盘时才有,exit 5 什么都
// 不留;而真正的根因(端点耗时 11→59s、并发把 13.7s 拖成 60s+、15s 超时导致
// 3 次 abort 空转)在当时的日志里完全不可见,只能另写探测脚本才量出来。
//
// 设计目标是回答两个问题:
//   1. 哪里不稳定 —— 每个端点的耗时分布/超时/重试,以及跨天基线偏离
//   2. 哪里浪费   —— 每次调用的**独有贡献**(去掉它会少多少最终数据)
//
// 两条铁律:
//   - **实时 append,不缓冲**。exit 2/4/5 与 SIGKILL 都可能让缓冲区蒸发,
//     而那些恰恰是最需要日志的场景。
//   - **监控绝不能成为新的故障源**。所有入口 try/catch 吞掉异常,
//     日志写不了就不写,主流程照常跑。

const fs = require('fs');
const path = require('path');

function logDir() {
  const base = process.env.EXP_COMPASS_LOG_DIR
    || path.join(process.env.HOME || '/tmp', '.cache', 'exp-compass-daily', 'logs');
  return base;
}

// 明细保留天数;runs 摘要保留条数
const REQUESTS_RETAIN_DAYS = parseInt(process.env.EXP_COMPASS_LOG_RETAIN_DAYS || '14', 10);
const RUNS_RETAIN = parseInt(process.env.EXP_COMPASS_RUNS_RETAIN || '200', 10);

const STATE = {
  enabled: process.env.EXP_COMPASS_OBS !== '0',
  runId: null,
  startedAt: 0,
  meta: {},
  requestsFile: null,
  runsFile: null,
  seq: 0,
  // source -> 累计
  bySource: new Map(),
  // source -> 该 source 返回过的实体 id
  idsBySource: new Map(),
  // source -> 经客户端过滤后**实际采纳**的 id。
  // 贡献度必须按这个算,不能按原始返回:exec-tasks 三条腿返回的是同一个
  // execution 的同一批任务(只是排序不同),原始 id 集合几乎全等,按返回算
  // 每条腿的 unique 恒为 0 —— 会得出"三腿全可砍"这个致命错误结论。
  // 三腿真正的差异在过滤阶段(不同排序 → 不同早退点 → 不同保留集合)。
  adoptedBySource: new Map(),
  // source -> role。lookup = 查表用(建映射/判归属),本就不进 payload,
  // 不该被算作"浪费"。
  roleBySource: new Map(),
  inflight: 0,
  finished: false,
};

// ---- path 模式化 ---------------------------------------------------------

// 把 /executions/2028/tasks 归一成 /executions/*/tasks。
// 高基数 path 会让聚合失效(每个 exec 一行看不出端点整体表现),
// 具体 id 单独存 ctx.exec / ctx.storyId。
function normalizePath(pathAndQuery) {
  const p = String(pathAndQuery).split('?')[0];
  return p.replace(/\/\d+(?=\/|$)/g, '/*');
}

// source = 端点模式 + 关键 query 语义。exec-tasks 的三条腿必须分开统计,
// 否则"哪条腿是浪费的"这个问题永远答不了。
function deriveSource(pathAndQuery, explicit) {
  if (explicit) return explicit;
  const [p, q = ''] = String(pathAndQuery).split('?');
  const np = normalizePath(p);
  const order = (q.match(/order=([^&]+)/) || [])[1];
  const status = (q.match(/status=([^&]+)/) || [])[1];
  const parts = [np];
  if (status) parts.push(`status=${status}`);
  if (order) parts.push(`order=${order}`);
  return parts.join('|');
}

// 从响应体里抽实体 id —— 贡献度分析的原料。
// 禅道各端点的列表字段名不同,逐个认;认不出就返回空,不影响主流程。
const LIST_KEYS = ['tasks', 'stories', 'bugs', 'executions', 'users', 'products'];
function extractIds(body) {
  const out = [];
  if (!body || typeof body !== 'object') return out;
  for (const k of LIST_KEYS) {
    const list = body[k];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || item.id == null) continue;
      out.push(Number(item.id));
      // 子任务也算这次调用的产出(collect.js 会 flatten children)
      for (const c of (item.children || [])) {
        if (c && c.id != null) out.push(Number(c.id));
      }
    }
  }
  // 详情类响应(/stories/{id} / /tasks/{id})本身就是一个实体
  if (!out.length && body.id != null) out.push(Number(body.id));
  return out;
}

// 失败归因分类 —— analyze 里"到底是什么在拖垮我们"这一行的来源
function classifyFailure(rec) {
  if (rec.ok) return null;
  const r = String(rec.reason || '');
  if (rec.timedOut || /abort/i.test(r)) return 'timeout';
  if (rec.reason === 'budget') return 'budget';
  if (rec.status === 401) return 'auth';
  if (rec.status >= 500) return 'server_5xx';
  if (rec.status === 429) return 'rate_limit';
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|fetch failed/i.test(r)) return 'network';
  if (rec.status >= 400) return 'http_4xx';
  return 'other';
}

// ---- 落盘 ----------------------------------------------------------------

function ensureDir() {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function appendLine(file, obj) {
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
}

// 清掉过期明细。只删自己命名规则下的文件,不碰目录里的其他东西。
function pruneOldRequestLogs(dir, today) {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - REQUESTS_RETAIN_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^requests-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && m[1] < cutoffStr) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* 删不掉就算了 */ }
    }
  }
}

function pruneRuns(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  if (lines.length <= RUNS_RETAIN) return;
  fs.writeFileSync(file, `${lines.slice(-RUNS_RETAIN).join('\n')}\n`, { mode: 0o600 });
}

// ---- 对外 API ------------------------------------------------------------

function startRun(meta = {}) {
  if (!STATE.enabled) return;
  try {
    const dir = ensureDir();
    const date = meta.date || new Date().toISOString().slice(0, 10);
    STATE.runId = `${date}T${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-${process.pid}`;
    STATE.startedAt = Date.now();
    STATE.meta = { ...meta, date };
    STATE.requestsFile = path.join(dir, `requests-${date}.jsonl`);
    STATE.runsFile = path.join(dir, 'runs.jsonl');
    STATE.seq = 0;
    STATE.bySource = new Map();
    STATE.idsBySource = new Map();
    STATE.adoptedBySource = new Map();
    STATE.roleBySource = new Map();
    STATE.finished = false;
    pruneOldRequestLogs(dir, date);
  } catch (_) {
    STATE.enabled = false; // 日志系统起不来就彻底关掉,绝不拖累采集
  }
}

// 请求开始:返回一个 token,用于在结束时算并发度。
// inflight 是这次事故的关键证据字段——"3 并发把 13.7s 拖成 60s+"只有记录了
// 当时并发度才看得出来。现在并发已降到 1,该字段短期恒为 1,但它是**验证
// 「并发=1 是对的」这个决策**的唯一凭据,也防止将来有人调大后无从对比。
function requestStart() {
  if (!STATE.enabled) return null;
  STATE.inflight++;
  return { t0: Date.now(), inflightAtStart: STATE.inflight };
}

function requestEnd(token, rec = {}) {
  if (!STATE.enabled) return;
  try {
    STATE.inflight = Math.max(0, STATE.inflight - 1);
    if (!token) return;
    const ms = Date.now() - token.t0;
    const source = deriveSource(rec.path, rec.source);
    const ids = rec.ok ? extractIds(rec.body) : [];
    const failure = classifyFailure(rec);

    const line = {
      run: STATE.runId,
      seq: ++STATE.seq,
      t: new Date().toISOString(),
      ms,
      source,
      path: normalizePath(rec.path),
      attempt: rec.attempt != null ? rec.attempt : 1,
      inflight: token.inflightAtStart,
      phase: rec.phase || null,
      ok: !!rec.ok,
      status: rec.status != null ? rec.status : null,
      rows: ids.length,
      total: rec.body && typeof rec.body.total === 'number' ? rec.body.total : null,
      ...(rec.ctx ? { ctx: rec.ctx } : {}),
      ...(failure ? { failure, reason: rec.reason } : {}),
    };
    appendLine(STATE.requestsFile, line);

    const agg = STATE.bySource.get(source) || {
      calls: 0, ms: [], ok: 0, failed: 0, retries: 0, returned: 0, failures: {},
    };
    agg.calls++;
    agg.ms.push(ms);
    if (rec.ok) agg.ok++; else agg.failed++;
    if ((rec.attempt || 1) > 1) agg.retries++;
    agg.returned += ids.length;
    if (failure) agg.failures[failure] = (agg.failures[failure] || 0) + 1;
    STATE.bySource.set(source, agg);

    if (ids.length) {
      const set = STATE.idsBySource.get(source) || new Set();
      for (const id of ids) set.add(id);
      STATE.idsBySource.set(source, set);
    }
  } catch (_) { /* 监控不能拖累采集 */ }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// 声明某次调用经客户端过滤后实际采纳了哪些 id。
// 不调用则退化为"原始返回即采纳"(适用于不做客户端过滤的端点)。
// 空数组是有意义的输入:表示"这次调用一条都没被采纳"。必须建立空 Set,
// 否则该 source 会退化成"按原始返回计算",把别人的独有贡献吃掉 —— 探针
// 未命中时正是这种情况(它的 page1 被复用给 lastEditedDate 腿了)。
function adopt(source, ids) {
  if (!STATE.enabled || !source || !Array.isArray(ids)) return;
  try {
    const set = STATE.adoptedBySource.get(source) || new Set();
    for (const id of ids) set.add(Number(id));
    STATE.adoptedBySource.set(source, set);
  } catch (_) { /* 监控不能拖累采集 */ }
}

// 标记 source 的角色。lookup = 查表(users 映射 / exec 归属 / 产品名),
// 其返回本就不该出现在 payload 里,分析时不能判它"浪费"。
function markRole(source, role) {
  if (!STATE.enabled || !source) return;
  try { STATE.roleBySource.set(source, role); } catch (_) { /* noop */ }
}

// 贡献度:每个 source **采纳**的 id 里,有多少最终进了 payload;其中多少是
// **只有它采纳**的(unique)。unique_contributed = 砍掉这个 source 会丢的条数,
// 这一列直接回答"哪些查询是浪费的"。
function computeContribution(payloadIds) {
  const finalSet = new Set((payloadIds || []).map(Number));
  // 有 adopted 记录的用 adopted,没有的退回 returned
  const effective = new Map();
  for (const [src, set] of STATE.idsBySource) effective.set(src, set);
  for (const [src, set] of STATE.adoptedBySource) effective.set(src, set);
  const sources = [...effective.keys()];
  const out = {};
  for (const src of sources) {
    const mine = effective.get(src) || new Set();
    let contributed = 0;
    let unique = 0;
    for (const id of mine) {
      if (!finalSet.has(id)) continue;
      contributed++;
      let seenElsewhere = false;
      for (const other of sources) {
        if (other === src) continue;
        if ((effective.get(other) || new Set()).has(id)) { seenElsewhere = true; break; }
      }
      if (!seenElsewhere) unique++;
    }
    out[src] = { contributed, unique_contributed: unique };
  }
  return out;
}

function finishRun(summary = {}) {
  if (!STATE.enabled || STATE.finished) return null;
  try {
    STATE.finished = true;
    const contrib = computeContribution(summary.payloadIds);
    const bySource = {};
    // 有些 source 零额外请求却有贡献 —— lastEditedDate 腿复用探针的 page1,
    // 不发新请求就没有 request 记录。若只按请求聚合,这条腿会在分析表上完全
    // 隐身,而被它覆盖掉贡献的另外两腿却显示"可砍",直接误导决策。
    // 补一个 calls=0 的空壳,让"零成本高贡献"的取法可见。
    for (const src of STATE.adoptedBySource.keys()) {
      if (!STATE.bySource.has(src)) {
        STATE.bySource.set(src, { calls: 0, ms: [], ok: 0, failed: 0, retries: 0, returned: 0, failures: {} });
      }
    }
    for (const [src, agg] of STATE.bySource) {
      const sorted = [...agg.ms].sort((a, b) => a - b);
      bySource[src] = {
        role: STATE.roleBySource.get(src) || 'data',
        calls: agg.calls,
        ok: agg.ok,
        failed: agg.failed,
        retries: agg.retries,
        ms_total: sorted.reduce((a, b) => a + b, 0),
        ms_p50: percentile(sorted, 50),
        ms_p95: percentile(sorted, 95),
        ms_max: sorted.length ? sorted[sorted.length - 1] : null,
        returned: agg.returned,
        contributed: (contrib[src] || {}).contributed || 0,
        unique_contributed: (contrib[src] || {}).unique_contributed || 0,
        ...(Object.keys(agg.failures).length ? { failures: agg.failures } : {}),
      };
    }
    const record = {
      run: STATE.runId,
      date: STATE.meta.date,
      started_at: new Date(STATE.startedAt).toISOString(),
      duration_ms: Date.now() - STATE.startedAt,
      exit_code: summary.exitCode != null ? summary.exitCode : 0,
      product: STATE.meta.product,
      api_calls: summary.apiCalls != null ? summary.apiCalls : STATE.seq,
      timings: summary.timings || {},
      counts: summary.counts || {},
      skipped: summary.skipped || [],
      degraded_non_voc: summary.degraded || [],
      by_source: bySource,
    };
    appendLine(STATE.runsFile, record);
    pruneRuns(STATE.runsFile);
    return record;
  } catch (_) {
    return null;
  }
}

// 读历史 runs,用于基线对比。只取同一 product、且成功的运行。
function readRuns({ file, limit = 50 } = {}) {
  try {
    const f = file || path.join(logDir(), 'runs.jsonl');
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean);
    const out = [];
    for (const l of lines.slice(-limit)) {
      try { out.push(JSON.parse(l)); } catch (_) { /* 坏行跳过 */ }
    }
    return out;
  } catch (_) {
    return [];
  }
}

// 本次 vs 历史基线的偏离。用中位数而非均值:慢窗的极端值不该污染基线。
function compareToBaseline(current, history, { source, metric = 'ms_p50' } = {}) {
  const vals = history
    .map((r) => (r.by_source || {})[source])
    .filter(Boolean)
    .map((s) => s[metric])
    .filter((v) => typeof v === 'number')
    .sort((a, b) => a - b);
  if (!vals.length) return null;
  const baseline = percentile(vals, 50);
  const cur = ((current.by_source || {})[source] || {})[metric];
  if (typeof cur !== 'number' || !baseline) return null;
  return { baseline, current: cur, deltaPct: Math.round(((cur - baseline) / baseline) * 100) };
}

// announce 里那一行健康摘要。取最慢的 source 作为代表 —— 它就是瓶颈。
function healthLine(record, history) {
  try {
    const entries = Object.entries(record.by_source || {});
    if (!entries.length) return null;
    const slowest = entries.sort((a, b) => (b[1].ms_p95 || 0) - (a[1].ms_p95 || 0))[0];
    const [src, agg] = slowest;
    const retries = entries.reduce((n, [, s]) => n + (s.retries || 0), 0);
    const timeouts = entries.reduce((n, [, s]) => n + ((s.failures || {}).timeout || 0), 0);
    const cmp = compareToBaseline(record, history, { source: src, metric: 'ms_p95' });
    const parts = [
      `${Math.round(record.duration_ms / 1000)}s`,
      `API ${record.api_calls}`,
    ];
    if (retries) parts.push(`重试 ${retries}`);
    if (timeouts) parts.push(`超时 ${timeouts}`);
    parts.push(`${src} P95 ${(agg.ms_p95 / 1000).toFixed(1)}s`);
    if (cmp) parts.push(`较基线 ${cmp.deltaPct >= 0 ? '+' : ''}${cmp.deltaPct}%${cmp.deltaPct > 80 ? ' ⚠️' : ''}`);
    return parts.join(' | ');
  } catch (_) {
    return null;
  }
}

module.exports = {
  startRun,
  requestStart,
  requestEnd,
  adopt,
  markRole,
  finishRun,
  readRuns,
  compareToBaseline,
  healthLine,
  computeContribution,
  // 供测试
  _internal: { normalizePath, deriveSource, extractIds, classifyFailure, percentile, STATE, logDir },
};
