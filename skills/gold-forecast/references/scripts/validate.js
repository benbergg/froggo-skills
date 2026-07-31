'use strict';
// C1-C16 自检:只出 findings,不删任何产物(删除属 run.js 编排职责,见设计 6.2/3.5)。
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJSON } = require('./lib/atomic-write');
const { parseForecast, SECTION_TITLES } = require('./forecast-parser');
const { DISCLAIMER_TEXT, DISCLAIMER_REQUIRED_PHRASES, REDLINE_WORDS,
  REDLINE_SELF_WORDS, REDLINE_FLOW_WORDS, REDLINE_DIRECTIVE_MARKERS,
  REDLINE_DESCRIPTIVE_SUBJECTS, REDLINE_NEGATION_MARKERS, REDLINE_COMPOUNDS,
  SECTION6_ALLOWED_CONCEPTS } = require('./lib/disclaimer');
const { promptScorecard, promptFacts, promptBaseline, findingTargets } = require('./lib/prompt-payload');

const HORIZONS = ['short', 'medium', 'long'];
const SECTIONS = ['一', '二', '三', '四', '五', '六', '七'];
// k_lo/k_hi 占位值,待 Task15 回测枚举宽度倍数标定后回填(设计 6.2 「C3 常数标定」)。
const C3_K_LO = 0.5;
const C3_K_HI = 2.0;
const C9_PROB_THRESHOLD = 0.08;
const C9_CENTER_FACTOR = 0.5;
const C4_TOL_REL = 0.005;
// 4 位的舍入误差 ≤5e-5,远在 C4 的 0.5% 与 C14 的 0.001 绝对下限之内,不会打架
const C16_MAX_DECIMALS = 4;
const OZ_TO_GRAM = 31.1035;
const COUNTERPARTY_GROUPS = ['commercial', 'noncommercial', 'nonreportable'];
const LESSON_METRICS = ['range', 'brier', 'dir'];
const C12_FORBIDDEN_WORDS = REDLINE_WORDS;
// 指令性构造的判定覆盖一–六段,第六段只放过设计要求它讲的那三个概念;
// 第六段另按「红线概念 + 具体数量同子句」判(见 checkRedline)。
const REDLINE_SECTIONS = ['一', '二', '三', '四', '五', '六'];
const C5_NEGATION_WORDS = ['无', '缺失', '暂无', '未获取', '不足', '缺少', '缺'];
const C7_INDICATORS = ['胜率', 'Brier', 'Winkler'];
const PLACEHOLDER_TOKENS = ['TODO', 'TBD', 'FIXME', '占位', '待补充', 'XXX', 'N/A', '{{', '}}'];
const HORIZON_KEYWORDS = {
  short: ['短期', '短周期', 'short'],
  medium: ['中期', '中周期', 'medium'],
  long: ['长期', '长周期', 'long'],
};

// 紧凑写法也要剥:实测 C4 拦下「20260730」,而池里存的是 2026-07-30。
// 仍校验月日范围 —— 整类 8 位数放行等于给溯源开缺口。
const DATE_RE = /\d{4}-\d{2}-\d{2}|(?<![\d.])(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?![\d.])/g;
// 负向前瞻防两件事:「3987-4059」区间写法的第二个数被吃成负数;
// 「DFII10」这类字段代码内嵌的数字被当成独立数值抽出。
const NUM_RE = /(?<![\d.A-Za-z])-?\d[\d,]*(?:\.\d+)?%?/g;
const SUFFIX_SKIP_RE = /^[年月日时分秒]/;
const PCTILE_SUFFIX_RE = /^分位/;
const SENTENCE_SPLIT_RE = /[。!!??\n]/;
// 子句必须切中文逗号:「本报告不提供仓位建议，模型仅输出 80% 概率区间」在句级只是一句,
// 按句判定会把每天都要写的免责句拦下。不切「、」—— 顿号连接的枚举项共享同一个主语。
const CLAUSE_SPLIT_RE = /[。!!??；;，,\n]/;
const RANGE_RE = /(\d[\d,]*(?:\.\d+)?)\s*[-~至到]\s*(\d[\d,]*(?:\.\d+)?)/g;
// 比较语境里的数字是阈值,不是「该周期概率等于它」。「三档概率均高于 0.5」要表达这个
// 正确意思就必然写 0.5,拦下它模型第 2/3 轮只会原样重犯 ⇒ 每天降级。溯源仍由 C4 管。
// 比较词与数字之间会夹名词(实测「高于对称值 0.5」),故放宽到若干非句读字符;
// 上界防的是「概率为 0.42，高于均值」这种跨子句误豁免 —— 那里还隔着逗号,本就切断了
const COMPARATOR_BEFORE_RE = /(高于|低于|大于|小于|超过|不足|不到|超出|至少|至多|不低于|不高于|突破|跌破)[^。，,；;]{0,6}$/;
const COMPARATOR_AFTER_RE = /^[\s]*(以上|以下|上方|下方|之上|之下)/;
// 全角数字对 `\d` 完全不可见:实测同一个编造值,`51737` 被 C4 拦下、`５１７３７` 零 findings,
// 一处编码问题同时关掉 C4 整个溯源层与产品红线。故在抽取数字的入口统一归一化,
// 各 check 里各写一遍就又是一份清单。`０-９．％` 与半角差恒为 0xFEE0 且长度 1:1,
// 不动全角逗号 —— 「58，3987」并成 `58,3987` 会被读成 583987。
const FULLWIDTH_RE = /[０-９．％]/g;
const CN_NUM_RE = /[零一二三四五六七八九十百千万两]+/g;
const CN_SCALE_CHARS = '十百千万';
// 量词跟在中文数字后面才构成数量。刻意不含「分」「步」「个」:十分/三步/九个月不是价位或仓位。
const CN_UNIT_RE = /^(?:成|倍|美元|元|点|手|吨|档|块|折)/;
// 价位构造:数字紧跟方位词、或「在/于/至 + 数字」⇒ 说的是价格点位,
// 即便一个指令性词都没有(「4022.2以下买入」「在4022买入」都是省略主语的祈使句)
const PRICE_LEVEL_RE = /(?:\d[\d,.]*|[零一二三四五六七八九十百千万两]{2,})\s*(?:美元|元|点)?\s*(?:以下|以上|附近|上方|下方|之上|之下|一带|关口)|(?:在|于|至|到)\s*(?:\d[\d,.]*|[零一二三四五六七八九十百千万两]{2,})/;
// 反事实警示句(「若当时按下沿止损将全部被扫」)与免责句同属绝不能自拦的一类
const COUNTERFACTUAL_RE = /(?:若|如果|假如|倘若|假设)[\s\S]*?(?:将|则|就|会|反而)/;
// 报告自述「本报告/本模型不…」是免责而非指令。只认这一种主语,不认裸「不」——
// 「不妨在3978买入」也带「不」,按裸字判会把祈使句一并放过。
const SELF_NEGATION_RE = /(?:本报告|本模型|本段|本区间|本次)[^，,。;；]*[不未无]/;

function findingOf(check, locator, expected, actual) {
  return { check, severity: 'block', locator, expected, actual };
}

function within(x, y, relTol = C4_TOL_REL, absFloor = 0.01) {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) <= Math.max(relTol * Math.abs(y), absFloor);
}

// 用等长空格占位,保持数字在原文中的下标不因剥离日期而漂移。
function stripDates(text) {
  return text.replace(DATE_RE, (m) => ' '.repeat(m.length));
}

// 全角数字归一化。放在数字提取的唯一入口,C4/C3/C5/C11 与红线一并受益。
function normalizeDigits(text) {
  return text.replace(FULLWIDTH_RE, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// 中文数量。第六段唯一的防线是「不给具体数值」,而上一版契约恰好把「需要计数」指向中文数字 ——
// 防线看不见的那一种,实测「仓位控制在三成以内，可用两倍杠杆」零 findings。
// 判据:带量词的(三成/两倍),或两字以上且第二字是位数的写法(三千九百八十七)。
// 「万一」「一两」「三五」这类非数量连用词、「数十」「几十」的约数、「第三方」由此排除。
function chineseQuantities(text) {
  const out = [];
  let m;
  CN_NUM_RE.lastIndex = 0;
  while ((m = CN_NUM_RE.exec(text))) {
    const run = m[0];
    if ('数几第'.includes(text[m.index - 1])) continue;
    const scaled = run.length >= 2 && CN_SCALE_CHARS.includes(run[1]);
    if (scaled || CN_UNIT_RE.test(text.slice(m.index + run.length))) out.push(run);
  }
  return out;
}

// 从正文抽取候选数字;百分比/分位后缀不在此处折算,由各检查按自身字段语义决定。
function extractNumbers(text) {
  const stripped = stripDates(normalizeDigits(text));
  const out = [];
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(stripped))) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    if (stripped[start - 1] === '第') continue;
    const after = stripped.slice(end, end + 2);
    const isPercent = raw.endsWith('%');
    const isPctile = !isPercent && PCTILE_SUFFIX_RE.test(after);
    if (!raw.includes('.') && !isPercent && !isPctile && SUFFIX_SKIP_RE.test(after)) continue;
    const numeric = Number(raw.replace(/%$/, '').replace(/,/g, ''));
    if (!Number.isFinite(numeric)) continue;
    out.push({ raw, numeric, isPercent, isPctile, index: start });
  }
  return out;
}

function splitSentences(text) {
  return text.split(SENTENCE_SPLIT_RE).filter((s) => s.trim().length > 0);
}

function fullProse(doc, sections = SECTIONS) {
  return sections.map((s) => doc.sections[s] || '').join('\n');
}

function deepNumbers(obj, out = []) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'number') { if (Number.isFinite(obj)) out.push(obj); return out; }
  if (Array.isArray(obj)) { obj.forEach((v) => deepNumbers(v, out)); return out; }
  if (typeof obj === 'object') { Object.values(obj).forEach((v) => deepNumbers(v, out)); return out; }
  return out;
}

function factsPool(facts, schema) {
  const pool = [];
  if (!facts || !schema) return pool;
  for (const [field, spec] of Object.entries(schema.fields)) {
    if (!spec.traceable) continue;
    const v = facts[field];
    if (typeof v === 'number' && Number.isFinite(v)) pool.push(v);
  }
  return pool;
}

// ---- C1: JSON 块存在且三期字段齐全、类型正确;七段正文齐全 ----
function checkC1(doc) {
  const out = [];
  if (!doc.json) {
    out.push(findingOf('C1', 'JSON块', '文件开头须有可解析的围栏 JSON 块', '缺失或解析失败'));
  } else if (!doc.json.horizons || typeof doc.json.horizons !== 'object') {
    out.push(findingOf('C1', 'json.horizons', '须包含三期 horizons 对象', typeof doc.json.horizons));
  } else {
    for (const h of HORIZONS) {
      const H = doc.json.horizons[h];
      const loc = `json.horizons.${h}`;
      if (!H) { out.push(findingOf('C1', loc, '三期字段须齐全', '缺失')); continue; }
      if (typeof H.prob_up !== 'number') out.push(findingOf('C1', `${loc}.prob_up`, '须为 number', typeof H.prob_up));
      if (typeof H.direction !== 'string') out.push(findingOf('C1', `${loc}.direction`, '须为 string', typeof H.direction));
      if (typeof H.low !== 'number') out.push(findingOf('C1', `${loc}.low`, '须为 number', typeof H.low));
      if (typeof H.high !== 'number') out.push(findingOf('C1', `${loc}.high`, '须为 number', typeof H.high));
    }
  }
  for (const s of SECTIONS) {
    if (!doc.sections[s]) out.push(findingOf('C1', `第${s}段`, '七段正文须齐全', '缺失'));
  }
  return out;
}

// ---- C2: direction 枚举与 prob_up 数值一致(>0.5 <-> up) ----
function checkC2(doc) {
  const out = [];
  if (!doc.json || !doc.json.horizons) return out;
  for (const h of HORIZONS) {
    const H = doc.json.horizons[h];
    if (!H || typeof H.prob_up !== 'number' || typeof H.direction !== 'string') continue;
    const expected = H.prob_up === 0.5 ? H.direction : (H.prob_up > 0.5 ? 'up' : 'down');
    if (H.direction !== expected) {
      out.push(findingOf('C2', `json.horizons.${h}.direction`, `prob_up=${H.prob_up} 时须为 ${expected}`, H.direction));
    }
  }
  return out;
}

// ---- C3: low<high 且区间宽度落在基线宽度的 [k_lo,k_hi] 内 ----
function checkC3(doc, ctx) {
  const out = [];
  const baseH = ctx.baseline && ctx.baseline.horizons;
  if (!doc.json || !doc.json.horizons || !baseH) return out;
  for (const h of HORIZONS) {
    const H = doc.json.horizons[h];
    const base = baseH[h];
    if (!H || !base || typeof H.low !== 'number' || typeof H.high !== 'number') continue;
    if (H.low >= H.high) {
      out.push(findingOf('C3', `json.horizons.${h}`, 'low 须小于 high', `low=${H.low},high=${H.high}`));
      continue;
    }
    const halfWidth = (H.high - H.low) / 2;
    const lo = C3_K_LO * base.half_width;
    const hi = C3_K_HI * base.half_width;
    if (halfWidth < lo || halfWidth > hi) {
      out.push(findingOf('C3', `json.horizons.${h}`,
        `区间半宽须落在 [${lo.toFixed(2)},${hi.toFixed(2)}](基线半宽 ${base.half_width} × [${C3_K_LO},${C3_K_HI}])`,
        halfWidth.toFixed(2)));
    }
  }
  return out;
}

// ---- C4: 正文数字须可溯源(白名单运算:加减/两值之差/百分比变化/盎司克/汇率比值/分位取整) ----
function c4Matches(x, direct, pair) {
  if (direct.some((p) => within(x, p))) return true;
  if (direct.some((p) => within(x, p / OZ_TO_GRAM) || within(x, p * OZ_TO_GRAM))) return true;
  for (const a of pair) {
    for (const b of pair) {
      if (a === b) continue;
      if (within(x, a + b) || within(x, a - b)) return true;
      if (b !== 0 && within(x, (a - b) / b)) return true; // 百分比变化(以比例表示)
      if (b !== 0 && within(x, a / b)) return true; // 汇率/比值类换算
    }
  }
  return false;
}

// 允许池必须等于「送进 prompt 的那份 payload」,由 lib/prompt-payload 单点投影 ——
// 池窄于 prompt 会让模型因引用自己看到的数字而被 block(设计 8.1 要求第五段写覆盖率与
// abandoned 计数,它们在 scorecard.coverage 里,旧池不含,等于自检在阻止报告满足设计);
// 池宽于 prompt 则等于放行编造。两者都只能靠共用同一个投影来杜绝。
// 注:胜率/Brier/Winkler 另有 C7 强制逐值对齐 scorecard,不因本处放宽而失守。
const textNumbers = (obj) => (obj ? extractNumbers(JSON.stringify(obj)).map((n) => n.numeric) : []);

function checkC4(doc, ctx) {
  const out = [];
  if (!doc.json) return out;
  const direct = [
    ...factsPool(ctx.facts, ctx.schema),
    ...deepNumbers(promptFacts(ctx.facts_raw)),
    ...deepNumbers(promptBaseline(ctx.baseline)),
    ...deepNumbers(promptScorecard(ctx.scorecard)),
    // findings 的数字藏在字符串里(`区间半宽须落在 [15.00,60.00]`),deepNumbers 看不见,
    // 必须按模型读到的形态抽 —— 池要装的是"模型能读到什么",不是"对象里有几个 number"。
    // **只取 expected**:actual/locator 带的是上一轮被判定为无出处的那个数字,
    // 并进池等于给「C4 刚拦下的编造」发一次性放行券(C-1)。切分与 prompt 侧同源。
    ...textNumbers(findingTargets(ctx.prior_findings)),
    ...deepNumbers(doc.json),
  ];
  const pair = factsPool(ctx.facts, ctx.schema);
  for (const s of SECTIONS.slice(0, 6)) {
    const text = doc.sections[s];
    if (!text) continue;
    for (const num of extractNumbers(text)) {
      const candidates = (num.isPercent || num.isPctile) ? [num.numeric, num.numeric / 100] : [num.numeric];
      if (!candidates.some((v) => c4Matches(v, direct, pair))) {
        out.push(findingOf('C4', `第${s}段:「${num.raw}」`,
          '数字须能在 facts/baseline/scorecard 中找到,或经白名单运算得出', num.raw));
      }
    }
  }
  return out;
}

// ---- C5: facts 中标 missing 的字段,正文禁止出现其 missing_keywords(排除显式声明缺失的句子) ----
function checkC5(doc, ctx) {
  const out = [];
  const missing = (ctx.facts && ctx.facts._missing) || [];
  if (!missing.length) return out;
  const sentences = splitSentences(fullProse(doc));
  for (const field of missing) {
    const spec = ctx.schema && ctx.schema.fields && ctx.schema.fields[field];
    const keywords = (spec && spec.missing_keywords) || [];
    for (const kw of keywords) {
      for (const sent of sentences) {
        const negated = C5_NEGATION_WORDS.some((n) => sent.includes(n));
        if (sent.includes(kw) && !negated) {
          out.push(findingOf('C5', `缺失字段 ${field}:「${sent.trim()}」`,
            `字段缺失时正文不得以关键词「${kw}」作论据`, sent.trim()));
        }
      }
    }
  }
  return out;
}

// ---- C6: 新教训引用的 prediction id 须存在、已结算、且判错;tag/metric/horizon 须在闭集内 ----
function isSettledWrong(h) {
  return !!h && h.settled === true && h.score && (h.score.dir_correct === false || h.score.in_range === false);
}

function checkC6(doc, ctx) {
  const out = [];
  const lessons = (doc.json && doc.json.new_lessons) || [];
  const contextTags = (ctx.schema && ctx.schema.context_tags) || [];
  const predictions = ctx.predictions || [];
  lessons.forEach((L, i) => {
    const loc = `new_lessons[${i}]`;
    if (!contextTags.includes(L.tag)) out.push(findingOf('C6', loc, `tag 须属于 ${JSON.stringify(contextTags)}`, L.tag));
    if (!LESSON_METRICS.includes(L.metric)) out.push(findingOf('C6', loc, `metric 须属于 ${JSON.stringify(LESSON_METRICS)}`, L.metric));
    if (!HORIZONS.includes(L.horizon)) out.push(findingOf('C6', loc, `horizon 须属于 ${JSON.stringify(HORIZONS)}`, L.horizon));
    const evidence = Array.isArray(L.evidence) ? L.evidence : [];
    if (!evidence.length) { out.push(findingOf('C6', `${loc}.evidence`, '须引用至少一条已结算且判错的预测 id', '空')); return; }
    for (const id of evidence) {
      const p = predictions.find((x) => x.id === id);
      const h = p && p.horizons && p.horizons[L.horizon];
      if (!isSettledWrong(h)) {
        out.push(findingOf('C6', `${loc}.evidence`, '引用的预测须存在、已结算且判错', id));
      }
    }
  });
  return out;
}

// ---- C7: 胜率/Brier/Winkler 须等于 scorecard;insufficient_sample 时不得出现该周期指标数字 ----
function checkC7(doc, ctx) {
  const out = [];
  const byH = (ctx.scorecard && ctx.scorecard.by_horizon) || {};
  const allowed = [];
  for (const h of HORIZONS) {
    const stat = byH[h];
    if (!stat) continue;
    // n 是样本量不是指标:设计要第五段如实写「样本不足」,而 C4 认它、C7 不认
    // 就等于两个自检对同一个数字给出相反判断,模型无路可走(部署首日实测)
    if (Number.isFinite(stat.n)) allowed.push(stat.n);
    if (stat.insufficient_sample) continue;
    deepNumbers(stat.final, allowed);
    deepNumbers(stat.baseline, allowed);
    deepNumbers(stat.naive, allowed);
  }
  const sentences = splitSentences(fullProse(doc));
  for (const sent of sentences) {
    if (!C7_INDICATORS.some((kw) => sent.includes(kw))) continue;
    for (const num of extractNumbers(sent)) {
      const candidates = (num.isPercent || num.isPctile) ? [num.numeric, num.numeric / 100] : [num.numeric];
      const ok = candidates.some((v) => allowed.some((a) => within(v, a, 0.0005, 0.001)));
      if (!ok) {
        out.push(findingOf('C7', `「${sent.trim()}」`, '胜率/Brier/Winkler 须直接引用 scorecard 数值,不得自算', num.raw));
      }
    }
  }
  return out;
}

// ---- C8: 新闻须带链接,且链接须来自 facts 的新闻列表 ----
function checkC8(doc, ctx) {
  const out = [];
  const allowed = new Set(((ctx.facts && ctx.facts.news) || []).map((n) => n.url));
  const URL_RE = /https?:\/\/[^\s)\]，。,、]+/g;
  const text = fullProse(doc, SECTIONS.slice(0, 6));
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (!allowed.has(url)) out.push(findingOf('C8', `链接「${url}」`, '新闻链接须来自事实包 news 列表', url));
  }
  return out;
}

// ---- C9: 偏离基线超阈值须有非空 adjustment_reason,且 cited_facts 全部存在于 schema ----
function checkC9(doc, ctx) {
  const out = [];
  const baseH = ctx.baseline && ctx.baseline.horizons;
  if (!doc.json || !doc.json.horizons || !baseH) return out;
  for (const h of HORIZONS) {
    const ai = doc.json.horizons[h];
    const base = baseH[h];
    if (!ai || !base || typeof ai.prob_up !== 'number' || typeof ai.low !== 'number' || typeof ai.high !== 'number') continue;
    const probDiff = Math.abs(ai.prob_up - base.prob_up);
    const centerDiff = Math.abs((ai.low + ai.high) / 2 - (base.low + base.high) / 2);
    const needsReason = probDiff > C9_PROB_THRESHOLD || centerDiff > C9_CENTER_FACTOR * base.half_width;
    if (!needsReason) continue;
    const reason = ai.adjustment_reason;
    const text = reason && typeof reason.text === 'string' ? reason.text.trim() : '';
    const loc = `json.horizons.${h}.adjustment_reason`;
    if (!text) { out.push(findingOf('C9', loc, '偏离基线超阈值须给出非空理由', JSON.stringify(reason || null))); continue; }
    const cited = Array.isArray(reason.cited_facts) ? reason.cited_facts : [];
    if (!cited.length) { out.push(findingOf('C9', `${loc}.cited_facts`, '理由须引用至少一个 facts 字段', '空')); continue; }
    const invalid = cited.filter((f) => !ctx.schema.fields[f]);
    if (invalid.length) out.push(findingOf('C9', `${loc}.cited_facts`, '引用字段须存在于 schema', JSON.stringify(invalid)));
  }
  return out;
}

// ---- C10: 表格语法闭合,表格数值须在正文其余处出现过 ----
function parseTables(text) {
  const lines = text.split('\n');
  const tables = [];
  let cur = null;
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) { (cur = cur || []).push(line); }
    else if (cur) { tables.push(cur); cur = null; }
  }
  if (cur) tables.push(cur);
  return tables;
}

function cellCount(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').length;
}

function checkC10(doc) {
  const out = [];
  for (const s of SECTIONS) {
    const text = doc.sections[s] || '';
    const tables = parseTables(text);
    for (const rows of tables) {
      if (rows.length < 2) { out.push(findingOf('C10', `第${s}段表格`, '须含表头行与分隔行', rows.join(' / '))); continue; }
      const headerCells = cellCount(rows[0]);
      const sepIsRule = /^\s*\|?[\s:|-]+\|?\s*$/.test(rows[1]);
      if (!sepIsRule || cellCount(rows[1]) !== headerCells) {
        out.push(findingOf('C10', `第${s}段表格`, '分隔行列数须与表头一致', rows[1]));
      }
      for (const row of rows.slice(2)) {
        if (cellCount(row) !== headerCells) out.push(findingOf('C10', `第${s}段表格`, '数据行列数须与表头一致', row));
      }
      const outside = fullProse(doc).split('\n').filter((l) => !rows.includes(l)).join('\n');
      const outsideNums = extractNumbers(outside);
      for (const row of rows.slice(2)) {
        for (const num of extractNumbers(row)) {
          const found = outsideNums.some((o) => within(num.numeric, o.numeric, 0.0005, 0.001));
          if (!found) out.push(findingOf('C10', `第${s}段表格`, '表格数值须在正文其余处出现过', num.raw));
        }
      }
    }
  }
  return out;
}

// ---- C11: 无占位符、无裸 markdown 泄漏(未闭合围栏)、无裸 > ----
function checkC11(doc) {
  const out = [];
  for (const s of SECTIONS) {
    const text = doc.sections[s] || '';
    for (const token of PLACEHOLDER_TOKENS) {
      if (text.includes(token)) out.push(findingOf('C11', `第${s}段`, '正文不得残留占位符', token));
    }
    for (const line of text.split('\n')) {
      if (/^\s*>/.test(line)) out.push(findingOf('C11', `第${s}段`, '正文不得出现裸引用标记 >', line.trim()));
    }
    if (((text.match(/```/g) || []).length) % 2 !== 0) {
      out.push(findingOf('C11', `第${s}段`, '代码围栏须成对闭合', text.slice(0, 40)));
    }
  }
  return out;
}

// 产品红线的机器约束。原先红线在正文一–六段唯一的执行者是提示词一行,而本仓库的记忆里
// 明确记着「弱模型无视提示词中止约束」。实测:在通过全部 14 项的 good 夹具第六段注入
// 「止损位设在3987」「4022.2以下买入,4059以上卖出」——零 findings。因为区间端点与基准价
// 本就在 C4 池里,拿它们当止损价/买卖点位是这套自检结构上永远抓不到的。
//
// 故两段各按自己的不变量写,而不是「禁止说什么」的词表:
//   第六段合法地要讲「怎么用波动率区间自行推算止损距离」,于是该段「讲概念」与「给指令」的
//   唯一分界就是有没有附上具体数量 ⇒ 判据是红线概念与具体数量落在同一子句。
//   曾实现成「整段禁数量」,结果把中文最自然的行文拦下(实测 9 条合法方法说明误拦 7 条:
//   「有一点需要说明」「并非一成不变」「分为两块」——量词表里的 点/档/块/元/成 全命中),
//   而 C12 是 block ⇒ 每天触发修复轮 ⇒ 每天降级发布。收窄量词表治不了它:「三成」是仓位的
//   规范写法,「一成不变」删不掉;判据必须落在语义维度而不是字面清单。
//   一–五段按指令性构造:指令性标记(或价位构造)与红线概念落在同一子句才算越界 ——
//   否则央行购金吨数/ETF 流向/COT 多空持仓这些设计要求必写的内容天天被拦。
// 长复合词先挖空,否则「净买入」留下的「买入」照样咬。
function maskCompounds(text) {
  let out = text;
  for (const w of REDLINE_COMPOUNDS) out = out.split(w).join(' '.repeat(w.length));
  return out;
}

function splitClauses(text) {
  return text.split(CLAUSE_SPLIT_RE).map((s) => s.trim()).filter((s) => s.length > 0);
}

function checkRedline(doc) {
  const out = [];
  for (const clause of splitClauses(doc.sections['六'] || '')) {
    const norm = normalizeDigits(clause);
    const masked = maskCompounds(norm);
    // 用全表(含第六段放行的止损/仓位/杠杆):放行的是「讲概念」,附上数量就变成给指令
    const word = REDLINE_WORDS.find((w) => masked.includes(w));
    if (!word) continue;
    const digit = norm.match(/\d[\d,.]*/);
    const cn = chineseQuantities(norm);
    if (!digit && !cn.length) continue;
    out.push(findingOf('C12', `第六段:「${clause.slice(0, 40)}」`,
      `第六段只讲方法不给具体数值,「${word}」不得与具体数量(阿拉伯数字或中文数量,如三成、两倍、四千零二十二)同现于一个子句`,
      digit ? digit[0] : cn[0]));
  }
  for (const s of REDLINE_SECTIONS) {
    const selfWords = s === '六'
      ? REDLINE_SELF_WORDS.filter((w) => !SECTION6_ALLOWED_CONCEPTS.includes(w))
      : REDLINE_SELF_WORDS;
    for (const sent of splitSentences(doc.sections[s] || '')) {
      // 描述性主语按整句判:「各国央行持续购金，仓位创历史新高」的主语在前一子句。
      // 第六段不需要描述第三方持仓,这层豁免在那里没有存在理由。
      const descriptive = s !== '六'
        && REDLINE_DESCRIPTIVE_SUBJECTS.some((w) => sent.includes(w));
      for (const clause of splitClauses(sent)) {
        const c = maskCompounds(normalizeDigits(clause));
        const self = selfWords.find((w) => c.includes(w));
        const flow = REDLINE_FLOW_WORDS.find((w) => c.includes(w));
        if (!self && !flow) continue;
        // 显式指令标记同样优先于反事实:「若跌破下沿就止损离场」是条件式指令(交易建议
        // 最标准的写法),而「若当时按下沿止损将被扫」不带指令标记,照旧豁免。
        const marker = REDLINE_DIRECTIVE_MARKERS.some((w) => c.includes(w));
        if (REDLINE_NEGATION_MARKERS.some((w) => c.includes(w))
          || (COUNTERFACTUAL_RE.test(c) && !marker) || SELF_NEGATION_RE.test(c)) continue;
        // 显式指令标记优先于描述性主语:「央行增持，建议半仓跟随」仍要拦。
        // 反之价位构造不足以压过第三方主语 —— 「央行在4000附近增持」与「在4000附近买入」
        // 的区别只在主语,前者是设计要求第二段必写的内容。
        if (!marker && descriptive) continue;
        // B 类词单独出现是描述第三方流向的写法;A 类词或价位构造才指向读者自己的操作
        if (!marker && !self && !PRICE_LEVEL_RE.test(c)) continue;
        out.push(findingOf('C12', `第${s}段:「${clause.slice(0, 40)}」`,
          `不得向读者给出「${self || flow}」这类操作指令;第三方持仓/流向请写成描述性表述,免责表述请与操作指令分开`,
          self || flow));
      }
    }
  }
  return out;
}

// ---- C12: 免责声明存在且未被改写(查必要短语,非逐字节相等;DISCLAIMER_TEXT 见 lib/disclaimer) ----
function checkC12(doc) {
  const out = checkRedline(doc);
  const text = doc.sections['七'] || '';
  if (!text) {
    out.push(findingOf('C12', '第七段', '第七段须存在并含固定免责声明', '缺失'));
    return out;
  }
  for (const phrase of DISCLAIMER_REQUIRED_PHRASES) {
    if (!text.includes(phrase)) {
      out.push(findingOf('C12', '第七段', `免责声明须含必要语句「${phrase}」,不得改写/删减`, text.slice(0, 80)));
    }
  }
  // 挖空必要短语再扫禁用词,不做否定豁免——否则会被「不排除…止损位…」绕过
  let scanText = text;
  for (const phrase of DISCLAIMER_REQUIRED_PHRASES) scanText = scanText.split(phrase).join('');
  for (const w of C12_FORBIDDEN_WORDS) {
    const idx = scanText.indexOf(w);
    if (idx === -1) continue;
    const snippet = scanText.slice(Math.max(0, idx - 15), idx + w.length + 15);
    out.push(findingOf('C12', `第七段:「...${snippet}...」`, `不得出现具体「${w}」操作建议`, w));
  }
  return out;
}

// ---- C13: counterparty 群体枚举/引用字段/数值须与 facts 一致;持仓全缺失时须显式标注方可豁免 ----
function checkC13(doc, ctx) {
  const out = [];
  const cp = doc.json && doc.json.counterparty;
  const missing = (ctx.facts && ctx.facts._missing) || [];
  const cftcAllMissing = ['cftc.net_spec', 'cftc.net_comm'].every((f) => missing.includes(f));

  if (!cp) {
    if (cftcAllMissing) {
      if (!/无持仓数据/.test(doc.sections['三'] || '')) {
        out.push(findingOf('C13', '第三段', '持仓数据全缺失时须显式标注「无持仓数据」方可豁免', '未标注'));
      }
    } else {
      out.push(findingOf('C13', 'json.counterparty', 'counterparty 须存在', '缺失'));
    }
    return out;
  }

  if (!COUNTERPARTY_GROUPS.includes(cp.group)) {
    out.push(findingOf('C13', 'json.counterparty.group', `须属于 ${JSON.stringify(COUNTERPARTY_GROUPS)}`, cp.group));
  }
  const cited = Array.isArray(cp.cited_fields) ? cp.cited_fields : [];
  if (!cited.length) out.push(findingOf('C13', 'json.counterparty.cited_fields', '须至少引用一个持仓字段', '空'));
  for (const f of cited) {
    if (!ctx.schema.fields[f]) { out.push(findingOf('C13', 'json.counterparty.cited_fields', '引用字段须存在于 schema', f)); continue; }
    const factVal = ctx.facts ? ctx.facts[f] : undefined;
    const claimVal = cp.values ? cp.values[f] : undefined;
    if (!within(claimVal, factVal, 0.0005, 0.5)) {
      out.push(findingOf('C13', `json.counterparty.values.${f}`, `须等于 facts 中 ${f}=${factVal}`, claimVal));
    }
  }
  return out;
}

// ---- C14: 正文中出现的三期 prob_up/low/high 须等于 JSON 块 ----
// 只在句子**唯一**指向一个周期时才锁定它。设计要求汇总三档,模型自然一句写完,
// 而取第一个匹配会把整句按 short 判 ⇒ 正确的中期/长期值全被拦,每天必触发。
function matchHorizonKeyword(sent) {
  const hit = HORIZONS.filter((h) => HORIZON_KEYWORDS[h].some((kw) => sent.includes(kw)));
  return hit.length === 1 ? hit[0] : undefined;
}

function checkC14(doc) {
  const out = [];
  if (!doc.json || !doc.json.horizons) return out;
  const sentences = splitSentences(fullProse(doc, SECTIONS.slice(0, 6)));
  const probOf = (h) => doc.json.horizons[h] && doc.json.horizons[h].prob_up;

  for (const sent of sentences) {
    if (!sent.includes('概率')) continue;
    const target = matchHorizonKeyword(sent);
    const cands = target ? [target] : HORIZONS;
    const norm = stripDates(normalizeDigits(sent));
    for (const num of extractNumbers(sent)) {
      if (!num.isPercent && !(num.raw.includes('.') && num.numeric >= 0 && num.numeric <= 1)) continue;
      if (COMPARATOR_BEFORE_RE.test(norm.slice(0, num.index))
        || COMPARATOR_AFTER_RE.test(norm.slice(num.index + num.raw.length))) continue;
      const value = num.isPercent ? num.numeric / 100 : num.numeric;
      const ok = cands.some((h) => within(value, probOf(h), 0.0005, 0.001));
      if (!ok) out.push(findingOf('C14', `「${sent.trim()}」`, '概率提及须等于 JSON 中对应周期的 prob_up', num.raw));
    }
  }

  for (const sent of sentences) {
    // 区间是 validate.js 里第二个取数点,归一化漏在这里等于「唯一入口」没做到:
    // 拿 long 端点冒充短期区间,半角出 C14、全角零 findings(两端点都在 C4 池里,C4 抓不到)
    const stripped = stripDates(normalizeDigits(sent));
    RANGE_RE.lastIndex = 0;
    let m;
    const target = matchHorizonKeyword(sent);
    const cands = target ? [target] : HORIZONS;
    while ((m = RANGE_RE.exec(stripped))) {
      const lo = Number(m[1].replace(/,/g, ''));
      const hi = Number(m[2].replace(/,/g, ''));
      const ok = cands.some((h) => {
        const H = doc.json.horizons[h];
        return H && within(lo, H.low, 0.0005, 0.5) && within(hi, H.high, 0.0005, 0.5);
      });
      if (!ok) out.push(findingOf('C14', `「${sent.trim()}」`, '区间提及须等于 JSON 中对应周期的 low/high', `${lo}-${hi}`));
    }
  }
  return out;
}

// ---- C15: 段标题须是设计 8.1 的七个,防「七段齐全但各讲各的」 ----
function checkC15(doc) {
  const out = [];
  for (const s of SECTIONS) {
    // 缺段归 C1;这里只管解析到了却换了主题的
    if (!doc.sections[s]) continue;
    const got = (doc.headings[s] || '').trim();
    // 只查前缀:「今日结论(2026-07-31)」这类尾注无害,拦的是标题换了主题
    if (!got.startsWith(SECTION_TITLES[s])) {
      out.push(findingOf('C15', `第${s}段标题`, `须以「${SECTION_TITLES[s]}」开头`, got || '空'));
    }
  }
  return out;
}

// ---- C16: 正文数字小数位上限,防直抄 JSON 浮点 ----
function checkC16(doc) {
  const out = [];
  for (const s of SECTIONS) {
    for (const num of extractNumbers(doc.sections[s] || '')) {
      // 首日实测「spec_pctile 为 0.37055837563451777」,17 位原样抄进报告
      const frac = (num.raw.replace(/%$/, '').split('.')[1] || '');
      if (frac.length > C16_MAX_DECIMALS) {
        out.push(findingOf('C16', `第${s}段:「${num.raw}」`, `小数位不得超过 ${C16_MAX_DECIMALS} 位`, `${frac.length} 位`));
      }
    }
  }
  return out;
}

const CHECKS = [
  checkC1, checkC2, checkC3, checkC4, checkC5, checkC6, checkC7,
  checkC8, checkC9, checkC10, checkC11, checkC12, checkC13, checkC14,
  checkC15, checkC16,
];

function validate(doc, ctx) {
  const findings = [];
  for (const check of CHECKS) findings.push(...check(doc, ctx));
  return { passed: findings.length === 0, findings };
}

// ---- CLI:真实 facts.json 是按 field 展开的嵌套结构,这里压平成 validate() 期望的扁平映射 ----
function flattenFactsForCli(factsJson, schema) {
  const flat = {};
  for (const field of Object.keys(schema.fields)) {
    const rec = factsJson.fields && factsJson.fields[field];
    if (rec && typeof rec.value === 'number') flat[field] = rec.value;
  }
  flat._missing = factsJson._missing || [];
  flat.news = (factsJson.news && factsJson.news.items) || [];
  return flat;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'facts.schema.json'), 'utf-8'));
  const md = fs.readFileSync(args.forecast, 'utf-8');
  const factsJson = JSON.parse(fs.readFileSync(args.facts, 'utf-8'));
  const baseline = JSON.parse(fs.readFileSync(args.baseline, 'utf-8'));
  const scorecard = JSON.parse(fs.readFileSync(args.scorecard, 'utf-8'));
  const predictionsDb = args.predictions && fs.existsSync(args.predictions)
    ? JSON.parse(fs.readFileSync(args.predictions, 'utf-8')) : { predictions: [] };
  const priorFindings = args['prior-findings'] && fs.existsSync(args['prior-findings'])
    ? JSON.parse(fs.readFileSync(args['prior-findings'], 'utf-8')) : null;

  const ctx = {
    schema,
    facts: flattenFactsForCli(factsJson, schema),
    // 原始 facts.json 整体进了 prompt,故整体可引用;flat 版只覆盖 schema 里的 traceable 字段
    facts_raw: factsJson,
    // 第 2/3 轮:上一轮 findings 也进了 prompt,同样必须可引用(否则修复指令自触发下一条自检)
    prior_findings: priorFindings,
    baseline,
    scorecard,
    predictions: predictionsDb.predictions || [],
    lessons: [],
  };
  const result = validate(parseForecast(md), ctx);
  atomicWriteJSON(args.out, result);
  console.error(`validate: passed=${result.passed}, findings=${result.findings.length}`);
}

if (require.main === module) main();

module.exports = {
  validate,
  checkC1, checkC2, checkC3, checkC4, checkC5, checkC6, checkC7,
  checkC8, checkC9, checkC10, checkC11, checkC12, checkC13, checkC14,
  checkC15, checkC16,
  C3_K_LO, C3_K_HI, C16_MAX_DECIMALS, C9_PROB_THRESHOLD, C9_CENTER_FACTOR, DISCLAIMER_TEXT,
  // 仅供测试:归一化是「数字提取入口」这一层的性质,从各 check 外面测不到它只有一处
  extractNumbers, normalizeDigits, chineseQuantities,
};
