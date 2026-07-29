'use strict';
// C1-C14 自检:只出 findings,不删任何产物(删除属 run.js 编排职责,见设计 6.2/3.5)。
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJSON } = require('./lib/atomic-write');
const { parseForecast } = require('./forecast-parser');

const HORIZONS = ['short', 'medium', 'long'];
const SECTIONS = ['一', '二', '三', '四', '五', '六', '七'];
// k_lo/k_hi 占位值,待 Task15 回测枚举宽度倍数标定后回填(设计 6.2 「C3 常数标定」)。
const C3_K_LO = 0.5;
const C3_K_HI = 2.0;
const C9_PROB_THRESHOLD = 0.08;
const C9_CENTER_FACTOR = 0.5;
const C4_TOL_REL = 0.005;
const OZ_TO_GRAM = 31.1035;
const COUNTERPARTY_GROUPS = ['commercial', 'noncommercial', 'nonreportable'];
const LESSON_METRICS = ['range', 'brier', 'dir'];
// 与 build-prompt.js 的 CONTRACT 免责声明全文同源,改一处需同步改另一处
// (两文件间无代码级引用,靠此注释与文本对照人工核对一致性)。
const DISCLAIMER_TEXT = '本报告为个人研究与决策辅助工具，不构成投资建议。预测基于历史统计模型与公开'
  + '数据生成，存在不确定性，过往表现不代表未来结果。报告不提供仓位、杠杆、买卖点位'
  + '或止损价等具体操作建议，请结合自身风险承受能力独立决策。据此操作，风险自负。';
// 逐字节相等会因一个空格/全角标点差异烧掉一整天的三轮修复,改为核对关键短语。
const C12_REQUIRED_PHRASES = ['不构成投资建议', '不提供仓位、杠杆、买卖点位或止损价', '风险自负'];
const C12_FORBIDDEN_WORDS = ['仓位', '杠杆', '止损', '买卖点位'];
// 免责声明本身须以否定语气提及这些词(“不提供仓位…”),故按句子级否定豁免,
// 只拦模型在免责声明之外真正给出仓位/止损等具体操作建议的情形。
const C12_NEGATION_WORDS = ['不', '无', '未', '禁止'];
const C5_NEGATION_WORDS = ['无', '缺失', '暂无', '未获取', '不足', '缺少', '缺'];
const C7_INDICATORS = ['胜率', 'Brier', 'Winkler'];
const PLACEHOLDER_TOKENS = ['TODO', 'TBD', 'FIXME', '占位', '待补充', 'XXX', 'N/A', '{{', '}}'];
const HORIZON_KEYWORDS = {
  short: ['短期', '短周期', 'short'],
  medium: ['中期', '中周期', 'medium'],
  long: ['长期', '长周期', 'long'],
};

const DATE_RE = /\d{4}-\d{2}-\d{2}/g;
// 负向前瞻防两件事:「3987-4059」区间写法的第二个数被吃成负数;
// 「DFII10」这类字段代码内嵌的数字被当成独立数值抽出。
const NUM_RE = /(?<![\d.A-Za-z])-?\d[\d,]*(?:\.\d+)?%?/g;
const SUFFIX_SKIP_RE = /^[年月日时分秒]/;
const PCTILE_SUFFIX_RE = /^分位/;
const SENTENCE_SPLIT_RE = /[。!!??\n]/;
const RANGE_RE = /(\d[\d,]*(?:\.\d+)?)\s*[-~至到]\s*(\d[\d,]*(?:\.\d+)?)/g;

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

// 从正文抽取候选数字;百分比/分位后缀不在此处折算,由各检查按自身字段语义决定。
function extractNumbers(text) {
  const stripped = stripDates(text);
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

function checkC4(doc, ctx) {
  const out = [];
  if (!doc.json) return out;
  const direct = [
    ...factsPool(ctx.facts, ctx.schema),
    ...deepNumbers(ctx.baseline && ctx.baseline.horizons),
    ...deepNumbers(ctx.scorecard && ctx.scorecard.by_horizon),
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
    if (!stat || stat.insufficient_sample) continue;
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

// ---- C12: 免责声明存在且未被改写(查必要短语,非逐字节相等;见 DISCLAIMER_TEXT 常量注释) ----
function checkC12(doc) {
  const out = [];
  const text = doc.sections['七'] || '';
  if (!text) {
    out.push(findingOf('C12', '第七段', '第七段须存在并含固定免责声明', '缺失'));
    return out;
  }
  for (const phrase of C12_REQUIRED_PHRASES) {
    if (!text.includes(phrase)) {
      out.push(findingOf('C12', '第七段', `免责声明须含必要语句「${phrase}」,不得改写/删减`, text.slice(0, 80)));
    }
  }
  for (const sent of splitSentences(text)) {
    const negated = C12_NEGATION_WORDS.some((n) => sent.includes(n));
    if (negated) continue;
    for (const w of C12_FORBIDDEN_WORDS) {
      if (sent.includes(w)) out.push(findingOf('C12', `「${sent.trim()}」`, `第七段不得给出具体「${w}」操作建议`, w));
    }
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
function matchHorizonKeyword(sent) {
  return HORIZONS.find((h) => HORIZON_KEYWORDS[h].some((kw) => sent.includes(kw)));
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
    for (const num of extractNumbers(sent)) {
      if (!num.isPercent && !(num.raw.includes('.') && num.numeric >= 0 && num.numeric <= 1)) continue;
      const value = num.isPercent ? num.numeric / 100 : num.numeric;
      const ok = cands.some((h) => within(value, probOf(h), 0.0005, 0.001));
      if (!ok) out.push(findingOf('C14', `「${sent.trim()}」`, '概率提及须等于 JSON 中对应周期的 prob_up', num.raw));
    }
  }

  for (const sent of sentences) {
    const stripped = stripDates(sent);
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

const CHECKS = [
  checkC1, checkC2, checkC3, checkC4, checkC5, checkC6, checkC7,
  checkC8, checkC9, checkC10, checkC11, checkC12, checkC13, checkC14,
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

  const ctx = {
    schema,
    facts: flattenFactsForCli(factsJson, schema),
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
  C3_K_LO, C3_K_HI, C9_PROB_THRESHOLD, C9_CENTER_FACTOR, DISCLAIMER_TEXT,
};
