'use strict';
const fs = require('node:fs');
const { atomicWriteJSON } = require('./lib/atomic-write');

const MIN_SAMPLE = 20;
const HORIZONS = ['short', 'medium', 'long'];
const C9_WINDOW = 20;
const C9_RATE_THRESHOLD = 0.6;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const confidenceOf = (probUp) => Math.max(probUp, 1 - probUp);

function settledOf(db, key) {
  return db.predictions
    .filter((p) => !p.degraded)
    .map((p) => ({ p, h: p.horizons[key] }))
    .filter((x) => x.h && x.h.settled && x.h.score);
}

function confidenceBucket(probUp) {
  const conf = confidenceOf(probUp);
  // 65% 用严格 >、55% 用 >=,和分箱下界对齐,避免边界值同时落入两档
  if (conf > 0.65) return 'gt65';
  if (conf >= 0.55) return '55to65';
  return 'lt55';
}

function group(rows, pick) {
  return {
    n: rows.length,
    dir_rate: rows.length ? rows.filter((r) => pick(r).dir).length / rows.length : null,
    brier: mean(rows.map((r) => pick(r).brier)),
    winkler: mean(rows.map((r) => pick(r).winkler)),
  };
}

function horizonStats(rows) {
  if (rows.length < MIN_SAMPLE) {
    return { n: rows.length, insufficient_sample: true, naive: null, baseline: null, final: null,
             by_confidence: null, calibration_buckets: null, range_bias: null, current_streak: 0 };
  }
  const f = group(rows, (r) => ({ dir: r.h.score.dir_correct, brier: r.h.score.brier, winkler: r.h.score.winkler }));
  const b = group(rows, (r) => ({ dir: r.h.score.baseline_dir_correct, brier: r.h.score.baseline_brier, winkler: r.h.score.baseline_winkler }));
  // naive 恒定猜涨,不产生区间,故 Winkler 无从计算。
  const n = { n: rows.length,
              dir_rate: rows.filter((r) => r.h.actual > r.p.base_price).length / rows.length,
              brier: mean(rows.map((r) => r.h.score.naive_brier)), winkler: null };

  const by_confidence = {};
  for (const key of ['gt65', '55to65', 'lt55']) {
    const sub = rows.filter((r) => confidenceBucket(r.h.final.prob_up) === key);
    by_confidence[key] = { n: sub.length,
      dir_rate: sub.length ? sub.filter((r) => r.h.score.dir_correct).length / sub.length : null };
  }

  const buckets = [];
  for (let lo = 0.5; lo < 1.0; lo += 0.05) {
    const hi = lo + 0.05;
    const sub = rows.filter((r) => { const p = confidenceOf(r.h.final.prob_up); return p >= lo && p < hi; });
    if (sub.length) buckets.push({ range: [Number(lo.toFixed(2)), Number(hi.toFixed(2))],
      claimed: mean(sub.map((r) => confidenceOf(r.h.final.prob_up))),
      actual: sub.filter((r) => r.h.score.dir_correct).length / sub.length, n: sub.length });
  }

  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].h.score.dir_correct) break;
    streak--;
  }

  return { n: rows.length, insufficient_sample: false, naive: n, baseline: b, final: f,
    by_confidence, calibration_buckets: buckets,
    range_bias: { above: rows.filter((r) => r.h.actual > r.h.final.high).length,
                  below: rows.filter((r) => r.h.actual < r.h.final.low).length },
    current_streak: streak };
}

function lessonStats(db, lessons) {
  const out = {};
  for (const L of lessons) {
    // 创建当日那次是证据不是检验,故只统计创建之后的情境再现。
    const rows = db.predictions
      .filter((p) => (p.context_tags || []).includes(L.tag) && p.id > L.created)
      .map((p) => p.horizons[L.horizon])
      .filter((h) => h && h.settled && h.score);
    const isHit = (s) => L.metric === 'range' ? s.in_range
                       : L.metric === 'brier' ? s.brier < s.baseline_brier
                       : s.dir_correct;
    out[L.id] = { trials: rows.length, hits: rows.filter((h) => isHit(h.score)).length,
                  metric: L.metric, horizon: L.horizon, status: L.status };
  }
  return out;
}

// C9(AI 自检)触发率过高说明模型可能根本没在用基线,这是唯一直接监控 AI 层失效的触发器。
function c9Trigger(db) {
  const recent = db.predictions.slice(-C9_WINDOW);
  if (recent.length < C9_WINDOW) return null;
  const flagged = recent.filter((p) => p.c9_triggered === true);
  const rate = flagged.length / recent.length;
  if (rate <= C9_RATE_THRESHOLD) return null;
  // 偏离基线用 short 周期的 prob_up 差值衡量;缺快照则退而取最近触发的 3 期
  const hasSnapshot = (p) => p.horizons && p.horizons.short && p.horizons.short.final && p.horizons.short.baseline;
  const ids = recent.every(hasSnapshot)
    ? [...recent].sort((a, b) => {
        const da = Math.abs(a.horizons.short.final.prob_up - a.horizons.short.baseline.prob_up);
        const dbv = Math.abs(b.horizons.short.final.prob_up - b.horizons.short.baseline.prob_up);
        return dbv - da;
      }).slice(0, 3).map((p) => p.id)
    : flagged.slice(-3).map((p) => p.id);
  return { kind: 'c9_high_rate', rate, ids };
}

function triggers(db, byHorizon, lessonsStat) {
  const t = [];
  for (const key of HORIZONS) {
    const stat = byHorizon[key];
    if (stat.insufficient_sample) continue; // 样本不足的周期跳过判定,避免误触发
    const tail = settledOf(db, key).slice(-3);
    if (tail.length === 3 && tail.every((r) => r.h.score.brier > r.h.score.baseline_brier)) {
      t.push({ kind: 'final_worse_than_baseline', horizon: key, ids: tail.map((r) => r.p.id) });
    }
    const c = stat.by_confidence;
    if (c && c.gt65 && c.lt55 && c.gt65.n > 0 && c.lt55.n > 0 && c.gt65.dir_rate < c.lt55.dir_rate) {
      t.push({ kind: 'confidence_inversion', horizon: key, gt65: c.gt65.dir_rate, lt55: c.lt55.dir_rate });
    }
  }
  for (const [id, s] of Object.entries(lessonsStat)) {
    if (s.status === 'active' && s.trials >= 5 && s.hits === 0) {
      t.push({ kind: 'lesson_ineffective', lesson_id: id, trials: s.trials });
    }
  }
  const c9 = c9Trigger(db);
  if (c9) t.push(c9);
  return t;
}

function buildScorecard(db, { lessons = [] } = {}) {
  const by_horizon = {};
  for (const key of HORIZONS) by_horizon[key] = horizonStats(settledOf(db, key));

  const all = db.predictions.flatMap((p) => HORIZONS.map((k) => p.horizons[k]).filter(Boolean));
  const coverage = {
    expected: all.length,
    settled: all.filter((h) => h.settled).length,
    skipped: (db.skipped_dates || []).length,
    abandoned: all.filter((h) => h.status === 'abandoned').length,
    approx: all.filter((h) => h.settled_kind === 'approx').length,
  };

  const by_model = {};
  for (const p of db.predictions) {
    const m = p.model_id || 'unknown';
    by_model[m] = by_model[m] || { n: 0 };
    by_model[m].n++;
  }

  const lessonsStat = lessonStats(db, lessons);
  return {
    generated_at: new Date().toISOString(),
    coverage, by_horizon, by_model,
    excluded: { degraded: db.predictions.filter((p) => p.degraded).length },
    review_triggers: triggers(db, by_horizon, lessonsStat),
    lessons: lessonsStat,
  };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = JSON.parse(fs.readFileSync(args.predictions, 'utf-8'));
  const lessons = args.lessons && fs.existsSync(args.lessons)
    ? (JSON.parse(fs.readFileSync(args.lessons, 'utf-8')).lessons || []) : [];
  const sc = buildScorecard(db, { lessons });
  atomicWriteJSON(args.out, sc);
  console.error(`scorecard: short n=${sc.by_horizon.short.n}, 触发器 ${sc.review_triggers.length} 条`);
}

if (require.main === module) main();
module.exports = { buildScorecard, horizonStats, lessonStats };
