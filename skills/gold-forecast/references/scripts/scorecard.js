'use strict';
const fs = require('node:fs');
const { atomicWriteJSON } = require('./lib/atomic-write');

const MIN_SAMPLE = 20;
const HORIZONS = ['short', 'medium', 'long'];
const C9_WINDOW = 20;
const C9_RATE_THRESHOLD = 0.6;

// 非有限值(缺字段、null)被 a+b 当 0 吸收后,均值会静默偏低,而 NaN 序列化出来
// 又与「样本不足」的正常 null 同形。故剔除并回传剔除数,由调用方显式上报。
function meanWithDrops(xs) {
  const good = xs.filter((x) => Number.isFinite(x));
  return {
    value: good.length ? good.reduce((a, b) => a + b, 0) / good.length : null,
    dropped: xs.length - good.length,
  };
}
const mean = (xs) => meanWithDrops(xs).value;
const confidenceOf = (probUp) => Math.max(probUp, 1 - probUp);

const BUCKET_COUNT = 10;   // [0.50,0.55) … [0.95,1.00],步长 0.05

// 分箱一律下闭上开,索引必须用整数算:`lo += 0.05` 累加到第 3 档会漂成 0.6000000000000001,
// 而边界打印出来仍是干净数字,0.60/0.65/0.70 这些模型最爱输出的整数概率会静默掉进下一档。
// 末档上闭,否则 conf=1.0 整箱丢失。
function bucketIndex(conf) {
  const idx = Math.floor((Math.round(conf * 1e6) - 500000) / 50000);
  return Math.min(Math.max(idx, 0), BUCKET_COUNT - 1);
}

function bucketRange(idx) {
  return [(50 + idx * 5) / 100, (55 + idx * 5) / 100];
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const bySettlementOrder = (x, y) =>
  cmp(x.h.settled_date || '', y.h.settled_date || '') || cmp(x.p.id || '', y.p.id || '');

function settledOf(db, key) {
  return db.predictions
    .filter((p) => !p.degraded)
    .map((p) => ({ p, h: p.horizons[key] }))
    .filter((x) => x.h && x.h.settled && x.h.score);
}

// 粗档由细箱索引派生,保证 by_confidence 与 calibration_buckets 对同一个 conf 归属一致
function confidenceBucket(probUp) {
  const idx = bucketIndex(confidenceOf(probUp));
  if (idx >= 3) return 'gt65';
  if (idx >= 1) return '55to65';
  return 'lt55';
}

function group(rows, pick, label, issues) {
  const brier = meanWithDrops(rows.map((r) => pick(r).brier));
  const winkler = meanWithDrops(rows.map((r) => pick(r).winkler));
  const dirs = rows.map((r) => pick(r).dir);
  const goodDirs = dirs.filter((d) => typeof d === 'boolean');
  report(issues, label, 'brier', brier.dropped);
  report(issues, label, 'winkler', winkler.dropped);
  report(issues, label, 'dir_correct', dirs.length - goodDirs.length);
  // 教训退休基准(设计 5.9.1):三类 metric 各要一个同口径的整体表现率
  const ranges = rows.map((r) => pick(r).inRange).filter((v) => typeof v === 'boolean');
  const beats = rows.map((r) => pick(r).beatBaseline).filter((v) => typeof v === 'boolean');
  return {
    n: rows.length,
    dir_rate: goodDirs.length ? goodDirs.filter(Boolean).length / goodDirs.length : null,
    brier: brier.value,
    winkler: winkler.value,
    in_range_rate: ranges.length ? ranges.filter(Boolean).length / ranges.length : null,
    beat_baseline_rate: beats.length ? beats.filter(Boolean).length / beats.length : null,
  };
}

// 三方 Brier 的累积均值序列,供报告画「演化曲线」。
// 累积均值而非逐条值:逐条 Brier 抖动太大,画出来只是噪声;这条曲线要回答的是
// 「随样本累积谁在赢」。非有限值跳过不计,与 meanWithDrops 同口径 ——
// 当 0 吸收会让曲线凭空下探,而 Brier 越低越好,等于伪造模型在变强。
function brierSeries(rows) {
  const picks = { final: (s) => s.brier, baseline: (s) => s.baseline_brier, naive: (s) => s.naive_brier };
  const acc = { final: { sum: 0, n: 0 }, baseline: { sum: 0, n: 0 }, naive: { sum: 0, n: 0 } };
  return [...rows].sort((a, b) => cmp(a.p.id || '', b.p.id || '')).map((r) => {
    const point = { id: r.p.id };
    for (const [key, pick] of Object.entries(picks)) {
      const v = pick(r.h.score);
      if (Number.isFinite(v)) { acc[key].sum += v; acc[key].n += 1; }
      point[key] = acc[key].n ? acc[key].sum / acc[key].n : null;
    }
    return point;
  });
}

function report(issues, group_, field, dropped) {
  if (dropped > 0) issues.push({ group: group_, field, dropped });
}

function horizonStats(rows, issues = []) {
  if (rows.length < MIN_SAMPLE) {
    return { n: rows.length, insufficient_sample: true, naive: null, baseline: null, final: null,
             by_confidence: null, calibration_buckets: null, range_bias: null, current_streak: 0,
             brier_series: null };
  }
  const f = group(rows, (r) => ({
    dir: r.h.score.dir_correct, brier: r.h.score.brier, winkler: r.h.score.winkler,
    inRange: r.h.score.in_range,
    beatBaseline: Number.isFinite(r.h.score.brier) && Number.isFinite(r.h.score.baseline_brier)
      ? r.h.score.brier < r.h.score.baseline_brier : undefined,
  }), 'final', issues);
  const b = group(rows, (r) => ({ dir: r.h.score.baseline_dir_correct, brier: r.h.score.baseline_brier, winkler: r.h.score.baseline_winkler }), 'baseline', issues);
  // naive 不产生区间,故 Winkler 无从计算。dir_rate 必须与 naive_brier 同源:
  // 用 actual > base_price(恒猜涨命中率)会让同一行的两个数字来自两个不同预测器。
  const naivePOf = (r) => (Number.isFinite(r.h.score.naive_p) ? r.h.score.naive_p : 0.5);
  report(issues, 'naive', 'naive_p', rows.filter((r) => !Number.isFinite(r.h.score.naive_p)).length);
  const naiveBrier = meanWithDrops(rows.map((r) => r.h.score.naive_brier));
  report(issues, 'naive', 'brier', naiveBrier.dropped);
  const n = { n: rows.length,
              dir_rate: rows.filter((r) => (naivePOf(r) > 0.5) === (r.h.actual > r.p.base_price)).length / rows.length,
              brier: naiveBrier.value, winkler: null };

  const by_confidence = {};
  for (const key of ['gt65', '55to65', 'lt55']) {
    const sub = rows.filter((r) => confidenceBucket(r.h.final.prob_up) === key);
    by_confidence[key] = { n: sub.length,
      dir_rate: sub.length ? sub.filter((r) => r.h.score.dir_correct).length / sub.length : null };
  }

  const byIndex = new Map();
  for (const r of rows) {
    const idx = bucketIndex(confidenceOf(r.h.final.prob_up));
    if (!byIndex.has(idx)) byIndex.set(idx, []);
    byIndex.get(idx).push(r);
  }
  const buckets = [...byIndex.keys()].sort((x, y) => x - y).map((idx) => {
    const sub = byIndex.get(idx);
    return { range: bucketRange(idx),
      claimed: mean(sub.map((r) => confidenceOf(r.h.final.prob_up))),
      actual: sub.filter((r) => r.h.score.dir_correct).length / sub.length, n: sub.length };
  });

  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].h.score.dir_correct) break;
    streak--;
  }

  return { n: rows.length, insufficient_sample: false, naive: n, baseline: b, final: f,
    brier_series: brierSeries(rows),
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
    // 必须按结算时序取尾,不能按数组下标:long 天然比 short 晚 19 个交易日到达,
    // 乱序 append 会让「最近连续 3 期」指向最旧的 3 条。
    const tail = settledOf(db, key).sort(bySettlementOrder).slice(-3);
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
  const data_quality = [];
  for (const key of HORIZONS) {
    const issues = [];
    by_horizon[key] = horizonStats(settledOf(db, key), issues);
    for (const it of issues) data_quality.push({ horizon: key, ...it });
  }

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
    // 非有限值被剔除的显式回执;放在 by_horizon 之外,免得计数被 C4/C7 当成可引用数值
    data_quality,
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
  for (const q of sc.data_quality) {
    console.error(`警告: ${q.horizon}.${q.group} 的 ${q.field} 有 ${q.dropped} 条非法值,已剔除后再取均值`);
  }
}

if (require.main === module) main();
module.exports = { buildScorecard, horizonStats, lessonStats, bucketIndex, confidenceBucket };
