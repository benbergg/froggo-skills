// 一次性策略探测(只读):验证 4 个关于取数方式的假设
//   H1  /products/{id}/stories 列表是否已带 executions 字段
//       → 若带,story 反查的 16 次串行 /stories/{id} 可归零(实测占 44-80s)
//   H2  exec-tasks 三腿的独有贡献:openedDate / finishedDate 腿各自能带来
//       多少 lastEditedDate 腿拿不到的任务 → 决定能否砍腿
//   H3  page2 是否空跑(rows < limit 时早退条件是否真的生效)
//   H4  /users 是否值得按天缓存
//
// 全程串行,避免并发把禅道拖慢(2026-07-27 实证 3 并发 → 单请求 25-60s)。
'use strict';
const fs = require('fs');
const path = require('path');

const token = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.cache/zentao/token.json'), 'utf-8')).token;
const base = process.env.ZENTAO_BASE_URL;
const DATE = process.env.PROBE_DATE || '2026-07-28';
const LOOKBACK_DAYS = 30;

const lb = new Date(`${DATE}T00:00:00Z`);
lb.setUTCDate(lb.getUTCDate() - LOOKBACK_DAYS);
const THRESHOLD = lb.toISOString().slice(0, 10);

let calls = 0;
async function get(p, timeoutMs = 120000) {
  calls++;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + p, {
      headers: { Token: token, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    const txt = await res.text();
    clearTimeout(timer);
    const ms = Date.now() - t0;
    let body = null;
    try { body = JSON.parse(txt.replace(/[\x00-\x1F]/g, (c) => (c === '\n' || c === '\t' ? c : ''))); } catch (_) {}
    return { ok: res.ok, ms, body, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, ms: Date.now() - t0, body: null, err: e.name };
  }
}

const inWindow = (v) => {
  if (!v || String(v).startsWith('0000-')) return false;
  return String(v).slice(0, 10) >= THRESHOLD;
};

(async () => {
  console.log(`# 策略探测 date=${DATE} threshold=${THRESHOLD}`);

  // ---- H1: stories 列表带不带 executions ----------------------------------
  console.log('\n## H1  /products/95/stories 是否已带 executions 字段');
  const st = await get('/products/95/stories?limit=100&page=1');
  if (!st.ok) {
    console.log(`  FAIL ${st.err || st.status} (${st.ms}ms)`);
  } else {
    const list = st.body.stories || [];
    const s0 = list[0] || {};
    const keys = Object.keys(s0);
    console.log(`  ${st.ms}ms  total=${st.body.total}  rows=${list.length}`);
    console.log(`  字段: ${keys.join(',')}`);
    console.log(`  含 executions? ${Object.prototype.hasOwnProperty.call(s0, 'executions') ? 'YES' : 'NO'}`);
    // 对照:单个 story 详情里 executions 长什么样
    if (list.length) {
      const d = await get(`/stories/${list[0].id}`);
      const execs = d.ok ? Object.keys((d.body && d.body.executions) || {}) : null;
      console.log(`  /stories/${list[0].id} 详情 ${d.ms}ms  executions=${execs ? JSON.stringify(execs) : 'FAIL'}`);
      if (d.ok) {
        const detailKeys = Object.keys(d.body);
        const onlyInDetail = detailKeys.filter((k) => !keys.includes(k));
        console.log(`  详情独有字段(列表拿不到): ${onlyInDetail.join(',') || '(无)'}`);
      }
    }
  }

  // ---- H4: users ----------------------------------------------------------
  console.log('\n## H4  /users 规模与耗时(评估按天缓存价值)');
  const u = await get('/users?limit=100&page=1');
  console.log(`  ${u.ms}ms  total=${u.ok ? u.body.total : 'FAIL'}  rows=${u.ok ? (u.body.users || []).length : 0}`);

  // ---- H2 + H3: 三腿独有贡献 & page2 是否空跑 -----------------------------
  console.log('\n## H2/H3  exec-tasks 三腿独有贡献 + 分页早退');
  const LEGS = [
    { q: 'order=lastEditedDate_desc', field: 'lastEditedDate', skipNullEarly: false },
    { q: 'order=openedDate_desc', field: 'openedDate', skipNullEarly: false },
    { q: 'order=finishedDate_desc', field: 'finishedDate', skipNullEarly: true },
  ];
  for (const execId of [2028, 3247, 3436]) {
    console.log(`\n### execution ${execId}`);
    const legSets = {};
    for (const leg of LEGS) {
      const ids = new Set();
      let pages = 0;
      let totalMs = 0;
      let reachedEnd = false;
      for (let page = 1; page <= 3 && !reachedEnd; page++) {
        const r = await get(`/executions/${execId}/tasks?${leg.q}&limit=100&page=${page}`);
        pages++;
        totalMs += r.ms;
        if (!r.ok) { console.log(`  ${leg.field} page${page} FAIL ${r.err || r.status} (${r.ms}ms)`); break; }
        const rows = r.body.tasks || [];
        if (page === 1) console.log(`  ${leg.field.padEnd(15)} page1 ${String(r.ms).padStart(6)}ms rows=${String(rows.length).padStart(3)} total=${r.body.total}`);
        else console.log(`  ${leg.field.padEnd(15)} page${page} ${String(r.ms).padStart(6)}ms rows=${String(rows.length).padStart(3)}  ← 第 ${page} 页是否有新数据`);
        if (rows.length === 0) break;
        for (const t of rows) {
          const v = t[leg.field];
          if (!v || String(v).startsWith('0000-')) {
            if (leg.skipNullEarly) { reachedEnd = true; break; }
            continue;
          }
          if (String(v).slice(0, 10) < THRESHOLD) { reachedEnd = true; break; }
          ids.add(t.id);
        }
        if (rows.length < 100) break;
      }
      legSets[leg.field] = ids;
      console.log(`  ${leg.field.padEnd(15)} => 窗口内 ${ids.size} 条, ${pages} 页, ${totalMs}ms`);
    }
    // 独有贡献
    const le = legSets.lastEditedDate || new Set();
    const op = legSets.openedDate || new Set();
    const fi = legSets.finishedDate || new Set();
    const union = new Set([...le, ...op, ...fi]);
    const onlyOp = [...op].filter((x) => !le.has(x));
    const onlyFi = [...fi].filter((x) => !le.has(x));
    const onlyFiVsBoth = [...fi].filter((x) => !le.has(x) && !op.has(x));
    console.log(`  --- 并集 ${union.size} 条`);
    console.log(`  lastEditedDate 单腿覆盖: ${le.size}/${union.size}`);
    console.log(`  openedDate   独有(vs lastEdited): ${onlyOp.length} ${onlyOp.length ? JSON.stringify(onlyOp.slice(0, 8)) : ''}`);
    console.log(`  finishedDate 独有(vs lastEdited): ${onlyFi.length} ${onlyFi.length ? JSON.stringify(onlyFi.slice(0, 8)) : ''}`);
    console.log(`  finishedDate 独有(vs 另两腿并集): ${onlyFiVsBoth.length} ${onlyFiVsBoth.length ? JSON.stringify(onlyFiVsBoth.slice(0, 8)) : ''}`);
  }

  console.log(`\n# 总调用 ${calls} 次`);
})();
