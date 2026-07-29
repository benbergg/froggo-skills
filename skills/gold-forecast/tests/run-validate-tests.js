'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURE } = require('./helpers');
const { parseForecast } = require('../references/scripts/forecast-parser');
const { validate } = require('../references/scripts/validate');
const { buildPrompt } = require('../references/scripts/build-prompt');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'references', 'schemas', 'facts.schema.json'), 'utf-8'));
const md = (n) => fs.readFileSync(FIXTURE(n), 'utf-8');

const CTX = () => ({
  schema: SCHEMA,
  facts: { 'lbma.pm_usd': 4022.2, 'fred.DFII10': 2.44, 'eastmoney.UDI': 101.29,
           'cftc.net_comm': -213199, 'cftc.net_spec': 183910,
           _missing: [], news: [{ url: 'https://example.com/a' }] },
  baseline: { horizons: { short: { prob_up: 0.53, low: 3978, high: 4067, half_width: 44.5 },
                          medium: { prob_up: 0.55, low: 3922, high: 4124, half_width: 101 },
                          long: { prob_up: 0.58, low: 3818, high: 4234, half_width: 208 } } },
  scorecard: { by_horizon: { short: { n: 25, insufficient_sample: false,
                                      final: { dir_rate: 0.571, brier: 0.2377, winkler: 79.1 },
                                      baseline: { dir_rate: 0.558, brier: 0.2431, winkler: 86.4 },
                                      naive: { dir_rate: 0.525, brier: 0.2494, winkler: null } } } },
  predictions: [{ id: '2026-07-09', horizons: { short: { settled: true, score: { dir_correct: false, in_range: false } } } }],
  lessons: [],
});

const findings = (name, patch = {}) => validate(parseForecast(md(name)), { ...CTX(), ...patch }).findings;
const codes = (name, patch) => findings(name, patch).map((f) => f.check);

test('T1: 合法样本全部通过', () => {
  const r = validate(parseForecast(md('forecast-good.md')), CTX());
  assert.equal(r.passed, true, JSON.stringify(r.findings));
});

test('T2: 解析出 JSON 块与七段正文', () => {
  const doc = parseForecast(md('forecast-good.md'));
  assert.ok(doc.json.horizons.short.prob_up > 0);
  for (const k of ['一', '二', '三', '四', '五', '六', '七']) assert.ok(doc.sections[k], `缺第${k}段`);
});

test('T3: C1 缺段被拦', () => {
  const broken = md('forecast-good.md').replace(/^## 六、[\s\S]*?(?=^## 七、)/m, '');
  assert.ok(validate(parseForecast(broken), CTX()).findings.some((f) => f.check === 'C1'));
});

test('T4: C2 方向与概率不一致被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.json.horizons.short.direction = 'down';
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C2'));
});

test('T5: C3 区间宽度越界被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.json.horizons.short.low = 1000;
  doc.json.horizons.short.high = 9000;
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C3'), '拉宽保命必须被拦');
});

test('T6: C4 无来源数字被拦', () => {
  assert.ok(codes('forecast-c4-bad.md').includes('C4'));
});

test('T7: C4 允许白名单运算得出的数字', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['四'] += '\n实际利率 2.44%,美元指数 101.29,两者之差 -98.85。';
  assert.equal(validate(doc, CTX()).findings.some((f) => f.check === 'C4'), false);
});

test('T8: C5 缺失字段的相关论据被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['三'] += '\n投机净多持续增加,拥挤度抬升。';
  const c = validate(doc, { ...CTX(), facts: { ...CTX().facts, _missing: ['cftc.net_spec'] } });
  assert.ok(c.findings.some((f) => f.check === 'C5'), '数据缺失却写相关论据必须被拦');
});

test('T9: C6 教训必须引用已结算且判错的预测', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.json.new_lessons = [{ text: 'x', tag: 'pre_cpi', metric: 'range', horizon: 'short', evidence: ['2099-01-01'] }];
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C6'));
});

test('T10: C6 拒绝越界的 tag 与 metric', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.json.new_lessons = [{ text: 'x', tag: 'not_a_tag', metric: 'range', horizon: 'short', evidence: ['2026-07-09'] }];
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C6'));
});

test('T11: C7 自算胜率被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['五'] += '\n近 30 日方向胜率 88.8%。';
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C7'));
});

test('T12: C7 样本不足时正文不得出现该指标数字', () => {
  const doc = parseForecast(md('forecast-good.md'));
  const sc = { by_horizon: { short: { n: 8, insufficient_sample: true, final: null, baseline: null, naive: null } } };
  doc.sections['五'] += '\n方向胜率 57.1%。';
  assert.ok(validate(doc, { ...CTX(), scorecard: sc }).findings.some((f) => f.check === 'C7'));
});

test('T13: C8 新闻链接不在事实包内被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['二'] += '\n参见 https://evil.example/fake 的报道。';
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C8'));
});

test('T14: C9 大幅偏离基线且无理由被拦', () => {
  assert.ok(codes('forecast-c9-bad.md').includes('C9'));
});

test('T15: C9 理由引用不存在的字段被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.json.horizons.short.prob_up = 0.75;
  doc.json.horizons.short.adjustment_reason = { text: 'x', cited_facts: ['not.a.field'] };
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C9'));
});

test('T16: C13 对手盘数值与事实不符被拦', () => {
  assert.ok(codes('forecast-c13-bad.md').includes('C13'));
});

test('T17: C13 持仓缺失时豁免但必须显式标注', () => {
  const doc = parseForecast(md('forecast-good.md'));
  delete doc.json.counterparty;
  const ctx = { ...CTX(), facts: { ...CTX().facts, _missing: ['cftc.net_spec', 'cftc.net_comm'] } };
  const withNote = JSON.parse(JSON.stringify(doc));
  withNote.sections['三'] += '\n本期无持仓数据,对手盘分析缺失。';
  assert.equal(validate(withNote, ctx).findings.some((f) => f.check === 'C13'), false, '有标注应豁免');
  assert.ok(validate(doc, ctx).findings.some((f) => f.check === 'C13'), '静默豁免不行');
});

test('T18: C14 正文数字与 JSON 块不一致被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['一'] = doc.sections['一'].replace(/0\.58|58%/, '77%');
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C14'));
});

test('T19: findings 带可定位的 locator', () => {
  const f = findings('forecast-c4-bad.md').find((x) => x.check === 'C4');
  assert.ok(f.locator && f.locator.length > 0, 'locator 不精确等于让模型重猜');
  assert.ok(f.expected && f.actual);
});

test('T20: validate 不删除任何文件', () => {
  const src = fs.readFileSync(require.resolve('../references/scripts/validate.js'), 'utf-8');
  assert.equal(/rmSync|unlinkSync/.test(src), false,
    '删除属编排职责;校验器删产物会让 3 轮修复循环无从改起');
});

test('T21: C10 表格出现正文别处没有的数值被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['五'] += '\n\n| 指标 | 数值 |\n|---|---|\n| 测试值 | 999.9 |\n';
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C10'));
});

test('T22: C10 表格数值都能在正文找到时不拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['五'] += '\n\n| 指标 | 数值 |\n|---|---|\n| 现货价 | 4022.2 |\n';
  assert.equal(validate(doc, CTX()).findings.some((f) => f.check === 'C10'), false);
});

test('T23: C10 表格缺分隔行(语法未闭合)被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['五'] += '\n\n| 指标 | 数值 |\n| 现货价 | 4022.2 |\n';
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C10'));
});

test('T24: C11 裸引用标记 > 被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['三'] += '\n> 这是一段裸引用\n';
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C11'));
});

test('T25: C11 占位符残留被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['四'] += '\n本条依据TODO待补充。';
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C11'));
});

test('T26: C11 正常正文不拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  assert.equal(validate(doc, CTX()).findings.some((f) => f.check === 'C11'), false);
});

test('T27: C12 免责声明被改写缺必要语句被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['七'] = doc.sections['七'].replace('不构成投资建议', '仅供娱乐参考');
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C12'));
});

test('T28: C12 免责声明完整不拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  assert.equal(validate(doc, CTX()).findings.some((f) => f.check === 'C12'), false);
});

test('T29: C12 第七段出现非否定语境的止损字样被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['七'] += '\n建议设置止损位在3900美元。';
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C12'));
});

test('T30: 从 CONTRACT 实际文本(非手打)提取的免责声明片段应零 C12 finding', () => {
  const r = buildPrompt({ facts: {}, baseline: { horizons: {} }, scorecard: { by_horizon: {} }, lessons: [], contextTags: [] });
  const contractText = r.blocks.find((b) => b.name === 'contract').text;
  const m = contractText.match(/原样复制以下免责声明全文[^「]*「([\s\S]*?)」/);
  assert.ok(m, 'CONTRACT 中应能定位到免责声明片段,定位不到说明提示词结构已变');
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['七'] = m[1];
  const c12 = validate(doc, CTX()).findings.filter((f) => f.check === 'C12');
  assert.deepEqual(c12, [], `CONTRACT 里的免责声明片段自身不应触发 C12: ${JSON.stringify(c12)}`);
});

test('T31: C12 挖空必要短语后扫描,「不排除…止损位…」类绕过仍被拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  doc.sections['七'] += '\n不排除跌破3900，止损位设在此。';
  assert.ok(validate(doc, CTX()).findings.some((f) => f.check === 'C12'));
});

test('T32: C12 挖空必要短语后扫描,合法完整免责声明不误拦', () => {
  const doc = parseForecast(md('forecast-good.md'));
  assert.equal(validate(doc, CTX()).findings.some((f) => f.check === 'C12'), false);
});
