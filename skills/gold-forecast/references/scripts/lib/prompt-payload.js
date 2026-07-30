'use strict';
// 不变量:**进 prompt 的每个数字都必须能被 C4 引用**。
//
// 保证它的唯一可靠方式是让「送进 prompt 的对象」与「C4 的允许池」出自同一个投影。
// 两处各写一份必然漂移:顶层 data_quality 就是这么漏出去的 —— build-prompt 把整个
// scorecard 塞进不可截断的 calibration 块,而 C4 的池只取 by_horizon,于是那些数字
// 模型看得见、一引用就 block,三轮修复全废。
//
// 漂移的另一半更隐蔽:C4 的池窄于 prompt 时,**设计要求写的内容会变成写不出来**。
// 设计 8.1 规定第五段必须呈现「覆盖率与 abandoned 计数」,而它们在 scorecard.coverage
// 里 —— 旧池不含 coverage,等于自检在阻止报告满足设计。故本次按不变量把池放宽到
// 整个 payload,而不是逐个字段补。
//
// 反方向同样是不变量的一部分:**不想被引用的数字就不要送进 prompt**。
// data_quality 是运维诊断(被剔除的非有限值计数),模型本就不该在公开报告里引用
// 剔除计数,所以它从 payload 里剥掉 —— 剥掉之后它自然也不在池里,两边仍然一致。

const { N_BY_HORIZON } = require('../baseline');

// 运维元数据:模型不该引用,因此也不该看见。
// generated_at 还有个具体的坑:C4 的 stripDates 只吃 YYYY-MM-DD,ISO 时间戳的时分秒
// 会被当成独立数字抽出来(实测 "…T12:34:56.789Z" 泄漏出 34 与 56.789)。
const OPS_ONLY_SCORECARD_KEYS = ['data_quality', 'generated_at'];
const OPS_ONLY_FACTS_KEYS = ['generated_at'];

// by_horizon[*].brier_series 的长度 = 已结算条数,而 calibration 块**不可截断**:
// 实测 250 条时单块 100992 字节,已超整个 prompt 的 100KB 预算 ⇒ 每天 exit 7,
// 而运维照 SKILL.md 查到 calibration 后会发现没有任何旋钮能缩小它;更早还有一段
// 「可截断块被压扁 + C4 池仍按完整对象算 ⇒ 三轮修复全废 ⇒ 降级发布,全程 exit 0」的
// 静默期。剥掉零信息损失:序列末点恒等于 payload 里已有的 {final,baseline,naive}.brier,
// 唯一消费者 render.js 读的是 scorecard.json 而非 prompt。剥掉后恒定约 3KB。
const OPS_ONLY_HORIZON_KEYS = ['brier_series'];

const dropKeys = (obj, keys) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

function promptScorecard(scorecard) {
  const out = dropKeys(scorecard, OPS_ONLY_SCORECARD_KEYS);
  if (!out || !out.by_horizon || typeof out.by_horizon !== 'object') return out;
  const by_horizon = {};
  for (const [k, h] of Object.entries(out.by_horizon)) by_horizon[k] = dropKeys(h, OPS_ONLY_HORIZON_KEYS);
  return { ...out, by_horizon };
}
const promptFacts = (facts) => dropKeys(facts, OPS_ONLY_FACTS_KEYS);

// baseline 补上 n_sessions。原先模型只能从 `p0_1`/`p0_5`/`p0_20` 这几个**键名**里
// 猜出周期长度,而键名里的 5 与 20 会被抽成数字却不在池里 —— 报告里写「未来 5 个交易日」
// 就被 C4 拦下。周期长度是报告必须讲清的信息,让它成为正式字段而不是键名的副产品。
function promptBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || !baseline.horizons) return baseline;
  const horizons = {};
  for (const [key, h] of Object.entries(baseline.horizons)) {
    horizons[key] = N_BY_HORIZON[key] ? { n_sessions: N_BY_HORIZON[key], ...h } : h;
  }
  return { ...baseline, horizons };
}

function promptPayload({ facts, baseline, scorecard }) {
  return {
    facts: promptFacts(facts),
    baseline: promptBaseline(baseline),
    scorecard: promptScorecard(scorecard),
  };
}

// ---- findings 按信任度切分(C-1) ---------------------------------------
//
// 一条 finding 里有两类数字,信任度**相反**,决不能当成一类:
//   expected —— 自检器依据基线/事实自算的修正目标(C3 的 [15.00,60.00]、C13 的 facts 值)。
//               模型被要求照它修正,必然复述,不可引用就会重演 N-1。
//   actual / locator —— 上一轮被判定为**无出处**的那个具体数值。
//               C4 自己产的 finding 形如 {locator:"第二段:「51737」", actual:"51737"},
//               把它并进池 = 给「C4 刚拦下的编造数字」发一次性放行券,
//               而修复循环存在的理由恰恰是拦住它。实测:同一份 forecast 只差这一个 flag,
//               不带 --prior-findings 时 51737 被拦、带上就放行。
//
// 故在**块层**切开:targets 进可引用块与 C4 池,evidence(含上一轮原文)进不可引用块。
function findingTargets(findings) {
  return (findings || []).map((f, i) => ({ i: i + 1, check: f.check, expected: f.expected }));
}

function findingEvidence(findings) {
  return (findings || []).map((f, i) => ({ i: i + 1, check: f.check, locator: f.locator, actual: f.actual }));
}

// 每个进 prompt 的块都必须**显式表态**是否可引用。新增块时这里没有它的名字 ⇒
// 结构性测试当场红,而不是等某天生产上模型引用了它、被 C4 拦下、烧掉一轮修复才发现。
// 上一轮就是按点名的字段清单修的,于是漏了 prior_findings 与 lessons 两块。
const BLOCK_CITABILITY = {
  contract: { citable: false, reason: '固定模板:0.58/3987 之类是格式示例,不是数据' },
  facts: { citable: true, reason: '当日事实快照,本就是给模型的输入' },
  baseline: { citable: true, reason: '量化基线,本就是给模型的输入' },
  counterparty: { citable: true, reason: 'facts.cftc 的子集' },
  calibration: { citable: true, reason: 'scorecard 投影;设计 8.1 要求第五段引用覆盖率与 abandoned 计数' },
  prior_findings: {
    citable: true,
    reason: '只含 expected —— 自检器依据基线/事实自算的修正目标。模型被要求照它修正,'
      + '必然复述,不可引用就会让修复指令自己触发下一条自检(N-1)',
  },
  prior_output: {
    citable: false,
    reason: '上一轮的错值(actual/locator)与原文全文。这些正是自检刚判定为无出处的东西,'
      + '进池等于给「C4 已经抓到的编造」发一次性放行券(C-1),而修复循环存在的理由就是拦住它',
  },
  lessons: {
    citable: false,
    reason: '教训文本是模型自己写的历史散文,不是事实源。放进池等于给「把某天的数字洗进'
      + '教训库、此后永久可引用」开口子。教训是策略提示,报告无须复述其数字,'
      + '故取保守默认;若日后 lessons.json 有了写入端需重新评估',
  },
  news: {
    citable: false,
    reason: '外部不可信数据。契约本就要求数字溯源到 facts/baseline/calibration,'
      + '标题里的数字不得被当作事实引用',
  },
};

module.exports = {
  promptPayload, promptScorecard, promptFacts, promptBaseline,
  findingTargets, findingEvidence,
  OPS_ONLY_SCORECARD_KEYS, OPS_ONLY_FACTS_KEYS, OPS_ONLY_HORIZON_KEYS, BLOCK_CITABILITY,
};
