'use strict';
// 教训库写入端(设计 5.9)。纯函数,不碰文件系统 —— 落盘由 commit.js 在入库事务里做,
// 与 predictions.json 同成同败。
//
// trials/hits 不在这里维护:它们是 scorecard 对 predictions 的纯函数投影,单一事实源。
// 本模块只管三件 scorecard 算不出来的事:新教训入库、status 单向退休、膨胀天花板。

const MAX_NEW_PER_DAY = 2;
const MAX_ACTIVE = 20;
const RETIRE_MIN_TRIALS = 5;

// 基准按 metric 对齐,错配会让区间类教训拿方向胜率去比(设计 5.9.1)
const BASELINE_KEY = { dir: 'dir_rate', range: 'in_range_rate', brier: 'beat_baseline_rate' };

const idKey = (created, text) => `${created} ${text}`;
const seqOf = (id) => { const m = /^L(\d+)$/.exec(String(id || '')); return m ? Number(m[1]) : 0; };

function baselineRate(scorecard, lesson) {
  const h = (scorecard && scorecard.by_horizon && scorecard.by_horizon[lesson.horizon]) || null;
  const f = h && h.final;
  const v = f && f[BASELINE_KEY[lesson.metric]];
  return Number.isFinite(v) ? v : null;
}

// 单向:active → retired*。retired* 传进来原样返回,「不复活」由此天然满足(设计 5.9.2)。
function nextStatus(lesson, scorecard) {
  if (lesson.status !== 'active') return lesson.status;
  const s = (scorecard && scorecard.lessons && scorecard.lessons[lesson.id]) || null;
  if (!s || !(s.trials >= RETIRE_MIN_TRIALS)) return 'active';
  if (s.hits === 0) return 'retired_ineffective';
  const base = baselineRate(scorecard, lesson);
  // 基准不可得(样本不足)只挡 retired,不挡上面那条 —— hits=0 不依赖基准
  if (base !== null && s.hits / s.trials >= base) return 'retired';
  return 'active';
}

function applyLessons({ current, incoming, scorecard, createdId }) {
  if (!Array.isArray(current)) {
    throw new Error('lessons-store: current 必须是数组,实得 '
      + `${JSON.stringify(current).slice(0, 80)} —— 拒绝写入,以免覆盖教训库`);
  }
  const warnings = [];
  // 流转必须最先做:它释放名额,放在闸门之后会让新教训被误拒而告警指向「调大上限」
  const lessons = current.map((L) => ({ ...L, status: nextStatus(L, scorecard) }));

  const seen = new Set(lessons.map((L) => idKey(L.created, L.text)));
  const fresh = [];
  for (const c of incoming || []) {
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    if (!text) { warnings.push(`丢弃 text 为空的教训条目(tag=${c && c.tag})`); continue; }
    if (seen.has(idKey(createdId, text))) continue; // 重跑走这里,静默是对的
    fresh.push({ ...c, text });
  }

  for (const d of fresh.slice(MAX_NEW_PER_DAY)) {
    warnings.push(`每日新增上限 ${MAX_NEW_PER_DAY} 条,丢弃:${d.text}`);
  }

  let active = lessons.filter((L) => L.status === 'active').length;
  let maxSeq = lessons.reduce((m, L) => Math.max(m, seqOf(L.id)), 0);
  for (const c of fresh.slice(0, MAX_NEW_PER_DAY)) {
    if (active >= MAX_ACTIVE) { warnings.push(`active 已达上限 ${MAX_ACTIVE},拒收:${c.text}`); continue; }
    maxSeq += 1;
    lessons.push({
      id: `L${String(maxSeq).padStart(3, '0')}`,
      text: c.text, tag: c.tag, metric: c.metric, horizon: c.horizon,
      created: createdId, evidence: Array.isArray(c.evidence) ? c.evidence : [], status: 'active' });
    active += 1;
  }
  return { lessons, warnings };
}

module.exports = { applyLessons, MAX_NEW_PER_DAY, MAX_ACTIVE, RETIRE_MIN_TRIALS };
