// 探测:能否绕开 exec 慢端点取到 story-attached 任务的完整字段
//   T1  /tasks/{id} 端点是否存在、字段是否够、多快
//   T2  /executions/{id}/tasks 的 story= / status= 等过滤参数是否真生效
//       (memory 记载禅道 query 参数常被静默忽略,需实测)
//   T3  loose task 只用 1 腿够不够 —— 把 exec 端点职责缩小到"发现 loose task"
'use strict';
const fs = require('fs');
const path = require('path');

const token = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.cache/zentao/token.json'), 'utf-8')).token;
const base = process.env.ZENTAO_BASE_URL;
const DATE = process.env.PROBE_DATE || '2026-07-28';
const THRESHOLD = (() => {
  const d = new Date(`${DATE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
})();

let calls = 0;
async function get(p) {
  calls++;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(base + p, { headers: { Token: token, 'Content-Type': 'application/json' }, signal: ctrl.signal });
    const txt = await res.text();
    clearTimeout(timer);
    let body = null;
    try { body = JSON.parse(txt.replace(/[\x00-\x1F]/g, (c) => (c === '\n' || c === '\t' ? c : ''))); } catch (_) {}
    return { ok: res.ok, ms: Date.now() - t0, body, status: res.status, raw: txt.slice(0, 160) };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, ms: Date.now() - t0, body: null, err: e.name };
  }
}

const NEEDED = ['id', 'name', 'status', 'assignedTo', 'openedBy', 'openedDate', 'finishedDate',
  'lastEditedDate', 'deadline', 'estimate', 'consumed', 'left', 'progress', 'story',
  'execution', 'parent', 'deleted', 'children'];

(async () => {
  console.log(`# 取数路径探测 date=${DATE}\n`);

  // ---- T1: /tasks/{id} ----------------------------------------------------
  console.log('## T1  /tasks/{id} 单任务详情端点');
  const probeIds = [45878, 45625, 44720];
  let t1Ok = false;
  const t1Times = [];
  for (const id of probeIds) {
    const r = await get(`/tasks/${id}`);
    if (!r.ok) {
      console.log(`  /tasks/${id}  ${r.ms}ms  HTTP ${r.status || r.err}  ${r.raw || ''}`);
      continue;
    }
    t1Ok = true;
    t1Times.push(r.ms);
    const k = Object.keys(r.body || {});
    const miss = NEEDED.filter((f) => !k.includes(f));
    console.log(`  /tasks/${id}  ${r.ms}ms  OK  字段数=${k.length}  deriveTask 缺失: ${miss.join(',') || '(无)'}`);
  }
  if (t1Ok) {
    const avg = Math.round(t1Times.reduce((a, b) => a + b, 0) / t1Times.length);
    console.log(`  → 均耗时 ${avg}ms;22 条 story task 串行约 ${Math.round(avg * 22 / 1000)}s`);
  }

  // ---- T2: exec tasks 的过滤参数是否生效 ----------------------------------
  console.log('\n## T2  /executions/2028/tasks 过滤参数是否真生效');
  const baseR = await get('/executions/2028/tasks?order=id_desc&limit=100&page=1');
  console.log(`  裸查询            ${baseR.ms}ms  total=${baseR.ok ? baseR.body.total : 'FAIL'}  rows=${baseR.ok ? (baseR.body.tasks || []).length : 0}`);
  for (const q of ['story=22494', 'status=doing', 'assignedTo=qingwa', 'lastEditedDate=>2026-07-01']) {
    const r = await get(`/executions/2028/tasks?${q}&order=id_desc&limit=100&page=1`);
    const rows = r.ok ? (r.body.tasks || []).length : 0;
    const same = r.ok && baseR.ok && r.body.total === baseR.body.total;
    console.log(`  ?${q.padEnd(24)} ${String(r.ms).padStart(5)}ms  total=${r.ok ? r.body.total : 'FAIL'}  rows=${rows}  ${same ? '← total 未变,参数被忽略' : '← 生效?'}`);
  }

  // ---- T3: loose task 用几腿才够 -----------------------------------------
  console.log('\n## T3  只为发现 loose task 的话,几腿够用');
  const LEGS = [
    { q: 'order=lastEditedDate_desc', f: 'lastEditedDate' },
    { q: 'order=openedDate_desc', f: 'openedDate' },
    { q: 'order=finishedDate_desc', f: 'finishedDate' },
  ];
  const looseByLeg = {};
  for (const leg of LEGS) {
    const r = await get(`/executions/2028/tasks?${leg.q}&limit=100&page=1`);
    const s = new Set();
    if (r.ok) {
      for (const t of (r.body.tasks || [])) {
        const all = [t, ...((t.children) || [])];
        for (const x of all) {
          const sid = Number(x.story || x.storyID || 0);
          if (sid) continue; // 只看 loose
          const v = x[leg.f];
          if (!v || String(v).startsWith('0000-')) continue;
          if (String(v).slice(0, 10) < THRESHOLD) continue;
          s.add(x.id);
        }
      }
    }
    looseByLeg[leg.f] = s;
    console.log(`  ${leg.f.padEnd(15)} 窗口内 loose task: ${s.size}`);
  }
  const le = looseByLeg.lastEditedDate || new Set();
  const op = looseByLeg.openedDate || new Set();
  const fi = looseByLeg.finishedDate || new Set();
  const union = new Set([...le, ...op, ...fi]);
  console.log(`  并集 ${union.size}`);
  console.log(`  lastEditedDate 单腿覆盖 loose: ${le.size}/${union.size}`);
  console.log(`  openedDate   独有: ${[...op].filter((x) => !le.has(x)).length}`);
  console.log(`  finishedDate 独有: ${[...fi].filter((x) => !le.has(x)).length}`);

  console.log(`\n# 总调用 ${calls} 次`);
})();
