// 验证:能否用 /stories/{id}.tasks 替代 /executions/{id}/tasks(慢端点)
//
// 判定标准(必须全部满足才敢换):
//   A. tasks 字段结构完整 —— deriveTask 需要的字段都在
//   B. 覆盖完整 —— 对同一 story,story.tasks 的 id 集合 ⊇ exec 三腿并集中
//      storyID=该 story 的任务集合(不能少一条,少了就是静默丢数)
//   C. 时间窗口语义 —— story.tasks 是全量还是也有窗口截断
//
// 注意 loose task(storyID=0)天然不在任何 story 下,那部分仍需 exec 端点,
// 本脚本一并量化它的规模。
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
    return { ok: res.ok, ms: Date.now() - t0, body, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, ms: Date.now() - t0, body: null, err: e.name };
  }
}

// deriveTask 依赖的字段(取自 collect.js)
const NEEDED = ['id', 'name', 'status', 'assignedTo', 'openedBy', 'openedDate', 'finishedDate',
  'lastEditedDate', 'deadline', 'estimate', 'consumed', 'left', 'progress', 'story', 'storyID',
  'execution', 'parent', 'deleted', 'children'];

(async () => {
  console.log(`# story.tasks 可替代性验证 date=${DATE} threshold=${THRESHOLD}\n`);

  // 1) 取 in-scope stories
  const sl = await get('/products/95/stories?limit=100&page=1');
  if (!sl.ok) { console.log('stories 列表失败'); return; }
  const stories = (sl.body.stories || []);
  console.log(`in-scope 候选 stories: ${stories.length}\n`);

  // 2) 先拿 exec 三腿并集作为"真值"(对照组)
  const LEGS = ['order=lastEditedDate_desc', 'order=openedDate_desc', 'order=finishedDate_desc'];
  const execTasks = new Map(); // taskId -> task
  for (const execId of [2028, 3247, 3436]) {
    for (const q of LEGS) {
      const r = await get(`/executions/${execId}/tasks?${q}&limit=100&page=1`);
      if (!r.ok) { console.log(`exec ${execId} ${q} FAIL`); continue; }
      for (const t of (r.body.tasks || [])) {
        if (!execTasks.has(t.id)) execTasks.set(t.id, t);
        for (const c of (t.children || [])) if (!execTasks.has(c.id)) execTasks.set(c.id, c);
      }
    }
  }
  console.log(`对照组: exec 三腿并集(含子任务) ${execTasks.size} 条任务\n`);

  // 按 storyID 分组
  const byStory = new Map();
  let looseCount = 0;
  for (const t of execTasks.values()) {
    const sid = Number(t.story || t.storyID || 0);
    if (!sid) { looseCount++; continue; }
    if (!byStory.has(sid)) byStory.set(sid, new Set());
    byStory.get(sid).add(t.id);
  }
  console.log(`其中 loose task(无 story 关联): ${looseCount} 条 ← 这部分无论如何都要 exec 端点\n`);

  // 3) 逐个 story 拉详情,比对
  console.log('## 逐 story 比对(story.tasks vs exec 并集中该 story 的任务)\n');
  let structOk = true;
  let firstShown = false;
  let totalStoryTasks = 0;
  const missingAll = [];
  const extraAll = [];
  const sample = stories.slice(0, 12);
  for (const s of sample) {
    const d = await get(`/stories/${s.id}`);
    if (!d.ok) { console.log(`S${s.id} 详情 FAIL`); continue; }
    const raw = d.body.tasks;
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw).flat() : []);
    const ids = new Set();
    for (const t of list) {
      if (t && t.id != null) ids.add(Number(t.id));
      for (const c of ((t && t.children) || [])) if (c && c.id != null) ids.add(Number(c.id));
    }
    totalStoryTasks += ids.size;

    if (!firstShown && list.length) {
      firstShown = true;
      const k = Object.keys(list[0]);
      const miss = NEEDED.filter((f) => !k.includes(f));
      console.log(`  [结构] tasks[0] 字段: ${k.join(',')}`);
      console.log(`  [结构] deriveTask 缺失字段: ${miss.join(',') || '(无)'}`);
      console.log(`  [结构] tasks 容器类型: ${Array.isArray(raw) ? 'Array' : typeof raw}\n`);
      if (miss.length) structOk = false;
    }

    const truth = byStory.get(Number(s.id)) || new Set();
    const missing = [...truth].filter((x) => !ids.has(Number(x)));
    const extra = [...ids].filter((x) => !truth.has(Number(x)));
    missingAll.push(...missing);
    extraAll.push(...extra);
    if (truth.size || ids.size) {
      const flag = missing.length ? ' ❌漏' : ' ✓';
      console.log(`  S${s.id}  story.tasks=${String(ids.size).padStart(3)}  exec并集=${String(truth.size).padStart(3)}  漏=${missing.length} 多=${extra.length}${flag}`);
      if (missing.length) console.log(`        漏掉: ${JSON.stringify(missing.slice(0, 10))}`);
    }
  }

  console.log(`\n## 结论`);
  console.log(`  结构完整: ${structOk ? 'YES' : 'NO'}`);
  console.log(`  story.tasks 合计 ${totalStoryTasks} 条`);
  console.log(`  相对 exec 并集漏掉: ${missingAll.length} 条 ${missingAll.length ? JSON.stringify(missingAll.slice(0, 20)) : ''}`);
  console.log(`  story.tasks 多出(exec 窗口外的历史任务): ${extraAll.length} 条`);
  console.log(`  loose task(必须走 exec): ${looseCount} 条`);
  console.log(`\n# 总调用 ${calls} 次`);
})();
