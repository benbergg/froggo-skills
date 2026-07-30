#!/usr/bin/env node
'use strict';
// 每日流水线编排器。顺序本身就是正确性约束(设计 3.5):结算先于入库、
// 校验先于入库、任何非零退出必须触发失败通知、修复循环的轮次由本模块持有。
//
// 本文件只做编排:各步的业务逻辑一律在各自脚本里,run.js 不重复实现任何判定。

const crypto = require('node:crypto');
const { N_BY_HORIZON } = require('./baseline');
const { C9_PROB_THRESHOLD, C9_CENTER_FACTOR } = require('./validate');

const MAX_FIX_ROUNDS = 3;
// 模型阶段 120s(单次约 15s,其中 CLI 冷启动 13s);采集阶段 300s,两者分列(设计 3.6/4.5)
const BUDGET = { collect_ms: 300_000, model_ms: 120_000 };
const HORIZON_KEYS = ['short', 'medium', 'long'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- 日期外推(缺口 3) --------------------------------------------------

function assertIsoDate(value, label) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw new Error(`run: ${label} 必须是 YYYY-MM-DD,实得 ${JSON.stringify(value)}`);
  }
}

// 从 base_date 往后数 n 个交易日,只跳周六周日。
// 不用 lib/trading-calendar.js 的 nthSession:它靠 calendar_tail 找 anchor 之后的日期,
// 而生产上 calendar_tail 全是过去的定盘日、末元素就是 base_date,filter(d > anchor) 恒空
// ⇒ 每次返回 null ⇒ 记录连 id 都构造不出来。
// 未知假日会让外推偏早,由 settle.js 的 approx 分支在结算时自我纠正(设计 5.3 pt.3)。
function addSessions(baseDate, n) {
  assertIsoDate(baseDate, 'base_date');
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`run.addSessions: n 必须是正整数,实得 ${JSON.stringify(n)}`);
  }
  // 一律走 UTC:本地时区的夏令时切换会让 +86400000 落回同一天或跳过一天
  let t = Date.parse(`${baseDate}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    t += 86400000;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return new Date(t).toISOString().slice(0, 10);
}

// ---- C9 独立复算(缺口 2) ----------------------------------------------

const centerOf = (h) => ((Number.isFinite(h && h.low) && Number.isFinite(h && h.high))
  ? (h.low + h.high) / 2 : NaN);

// 不能从 validate 的 findings 反推:checkC9 只在模型「没能给出合格理由」时才产 finding,
// 一个每天大幅偏离基线却每次都写了工整理由的模型 findings 里干干净净 ⇒ 20 天全记 false
// ⇒ scorecard 的 c9_high_rate 永远触发不了,而这恰是设计最想抓的情形。
// 故对 final vs baseline 独立复算「是否需要理由」,与 checkC9 共用同一组阈值常量。
function computeC9Triggered(finalHorizons, baselineHorizons) {
  for (const key of HORIZON_KEYS) {
    const f = finalHorizons && finalHorizons[key];
    const b = baselineHorizons && baselineHorizons[key];
    if (!f || !b) continue;
    if (Number.isFinite(f.prob_up) && Number.isFinite(b.prob_up)
      && Math.abs(f.prob_up - b.prob_up) > C9_PROB_THRESHOLD) return true;
    const fc = centerOf(f);
    const bc = centerOf(b);
    if (Number.isFinite(fc) && Number.isFinite(bc) && Number.isFinite(b.half_width)
      && Math.abs(fc - bc) > C9_CENTER_FACTOR * b.half_width) return true;
  }
  // 读取端是 `p.c9_triggered === true`,写 1 / "yes" / 计数值都会让那条触发器永久静默
  return false;
}

// ---- 进 prompt 的 scorecard(缺口 4) ------------------------------------

// 不变量:进 prompt 的每个数字都必须可引用。
// validate 的 C4 允许池只取 scorecard.by_horizon,而 build-prompt 把整个 scorecard
// 塞进不可截断的 calibration 块 ⇒ 顶层 data_quality(被剔除的非有限值计数)模型看得见、
// 却不在允许池里,一引用就触发 C4 → 三轮修复全废。它是运维诊断,不是预测输入。
function scorecardForPrompt(scorecard) {
  if (!scorecard || typeof scorecard !== 'object' || Array.isArray(scorecard)) return scorecard;
  const clone = { ...scorecard };
  delete clone.data_quality;
  return clone;
}

// ---- 预测记录装配(P14-1) ----------------------------------------------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// naive 恒为 p0_N(设计 5.5.2),必须取 features.p0_N ——
// 不能用 horizons.*.baseline.prob_up:该周期的 logistic 通过验收后它就不再等于 p0
// (baseline.js:`prob = coef ? predictLogistic(...) : p0`),而 naive 是无信息基准,
// 拿一个见过特征的模型输出当基准,回测增益的分母就不是「无信息」了。
function naivePOf(baseline, n) {
  const v = baseline && baseline.features && baseline.features[`p0_${n}`];
  return Number.isFinite(v) ? v : undefined;
}

const pickBand = (h) => ({ prob_up: h.prob_up, low: h.low, high: h.high });

// 把 parseForecast 输出 + baseline.json + facts.json 装配成设计 5.2 形状的记录。
// 集中在一个函数里而非散在 main() 各处:naive_p / c9_triggered / target_date 三个字段
// 此前无人认领,一次装配一次测到位才不会再漏。
function buildPredictionRecord({ doc, baseline, facts, modelId, degraded = false }) {
  if (!baseline || !baseline.horizons) throw new Error('run.buildPredictionRecord: 缺少 baseline.horizons');
  const baseDate = baseline.base_date;
  assertIsoDate(baseDate, 'baseline.base_date');

  const aiHorizons = (doc && doc.json && doc.json.horizons) || null;
  const horizons = {};
  for (const key of HORIZON_KEYS) {
    const b = baseline.horizons[key];
    if (!b) throw new Error(`run.buildPredictionRecord: baseline.horizons.${key} 缺失`);
    const n = N_BY_HORIZON[key];
    const ai = aiHorizons && aiHorizons[key];
    const h = {
      n_sessions: n,
      target_date: addSessions(baseDate, n),
      baseline: pickBand(b),
      // 降级时 final 即 baseline —— 只发基线预测,统计照常结算,不断档
      final: ai ? pickBand(ai) : pickBand(b),
      settled: false,
    };
    const naive = naivePOf(baseline, n);
    if (naive !== undefined) h.naive_p = naive;
    horizons[key] = h;
  }

  const finalHorizons = {};
  for (const key of HORIZON_KEYS) finalHorizons[key] = horizons[key].final;

  return {
    // id 就是 short 周期的 target_date(设计 5.2):upsert 的覆盖主键、buildIndex 的分年依据
    id: horizons.short.target_date,
    base_date: baseDate,
    base_price: baseline.base_price,
    base_source: `lbma:gold_pm:${baseDate}:v0`,
    // 完整性校验,防重跑不一致与意外漂移;不防刻意篡改(设计 5.2)
    facts_checksum: `sha256:${sha256(JSON.stringify(facts ?? null))}`,
    model_id: modelId || null,
    // 特征降级与编排层降级(pin 校验失败 / 修复循环耗尽)取或:两者都意味着
    // 这条 final 不是「M3 在完整特征下的判断」,都不该进 final 曲线
    degraded: Boolean(degraded) || ((baseline.degraded_features || []).length > 0),
    horizons,
    // 由 collect-facts.js 机械推导,M3 只读不写(设计 5.2 W-3)
    context_tags: (facts && facts.context_tags) || [],
    c9_triggered: computeC9Triggered(finalHorizons, baseline.horizons),
  };
}

module.exports = {
  MAX_FIX_ROUNDS, BUDGET, HORIZON_KEYS,
  addSessions, computeC9Triggered, scorecardForPrompt, naivePOf, buildPredictionRecord,
};
