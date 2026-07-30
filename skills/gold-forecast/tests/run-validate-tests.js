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

// —— MF-3:产品红线在正文一–六段的机器约束 ——
// 原先红线在一–六段唯一的执行者是提示词一行。实测在通过全部 14 项的 good 夹具第六段
// 注入下列越界句,findings 全部为空 —— 端点/基准价本就在 C4 池里,结构上抓不到。

// 在指定段落标题后插入一句,其余全不动
function inject(section, sentence) {
  const src = md('forecast-good.md');
  const re = new RegExp(`(## ${section}、[^\\n]*\\n\\n)`);
  assert.ok(re.test(src), `夹具里找不到第${section}段标题`);
  return src.replace(re, `$1${sentence}\n\n`);
}

test('T33: 第六段的止损价/买卖点位/加仓越界句必须被拦', () => {
  // 这几句在修法前全部零 findings;它们用的数字就是区间端点与基准价,C4 抓不到
  for (const s of ['建议在3987设置止损，突破4059可加仓。', '止损位设在3987。',
    '4022.2以下买入，4059以上卖出。', '可用2倍杠杆参与。', '建议投入3成仓位。']) {
    const f = validate(parseForecast(inject('六', s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `未被 C12 拦下: ${s} -> ${JSON.stringify(f)}`);
  }
});

test('T34: 第六段禁的是阿拉伯数字这个不变量,不是词表', () => {
  // 一句不含任何红线词、看似无害的数字同样要拦 —— 否则「用端点当止损价」永远绕得过
  const f = validate(parseForecast(inject('六', '区间半宽约为45点。')), CTX()).findings;
  assert.ok(f.some((x) => x.check === 'C12'), `无红线词但含数字的句子也须拦: ${JSON.stringify(f)}`);
  // 对照组:同一句改用中文数字表述,必须放行
  const ok = validate(parseForecast(inject('六', '区间半宽约为数十点。')), CTX()).findings;
  assert.deepEqual(ok.filter((x) => x.check === 'C12'), [], '中文数字表述不该被拦');
});

test('T35: 一–五段红线词与数字同句被拦,不同句则放行', () => {
  for (const s of ['建议仓位控制在2成以内。', '在3978附近买入较为合适。', '止损设在3978。']) {
    const f = validate(parseForecast(inject('四', s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `未被 C12 拦下: ${s} -> ${JSON.stringify(f)}`);
  }
  // 免责表述本身不带数字,必须放行 —— 否则每天都会因为一句免责话触发修复轮
  const ok = validate(parseForecast(inject('四', '本报告不提供仓位与杠杆建议。')), CTX()).findings;
  assert.deepEqual(ok.filter((x) => x.check === 'C12'), [], '不含数字的免责表述不该被拦');
});

test('T36: 现有全部夹具与降级模板的 C12 误报为 0', () => {
  const { checkC12 } = require('../references/scripts/validate');
  const { buildDegradedForecast } = require('../references/scripts/run');
  const names = fs.readdirSync(path.dirname(FIXTURE('forecast-good.md')))
    .filter((f) => /^forecast-.*\.md$/.test(f));
  assert.ok(names.length >= 4, `夹具太少(${names.length}),这条测不到东西`);
  for (const n of names) {
    assert.deepEqual(checkC12(parseForecast(md(n))), [], `${n} 触发了 C12 误报`);
  }
  // 降级模板是另一条独立的正文生成路径,红线检查同样要放行它
  const degraded = buildDegradedForecast({
    reason: '测试',
    baseline: { base_date: '2026-07-29', base_price: 4022.2,
      horizons: { short: { prob_up: 0.53, low: 3978, high: 4067 },
        medium: { prob_up: 0.55, low: 3922, high: 4124 },
        long: { prob_up: 0.58, low: 3818, high: 4234 } } },
  });
  assert.deepEqual(checkC12(parseForecast(degraded)), [], '降级模板触发了 C12 误报');
});

test('T37: 红线词表单点持有于 lib/disclaimer', () => {
  // 两处检查(第七段扫描、一–五段同句判定)共用一份;各写一份必然漂移
  const { REDLINE_WORDS } = require('../references/scripts/lib/disclaimer');
  for (const w of ['仓位', '杠杆', '止损', '买卖点位', '买入', '卖出', '加仓', '减仓']) {
    assert.ok(REDLINE_WORDS.includes(w), `红线词表缺 ${w}`);
  }
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'references', 'scripts', 'validate.js'), 'utf-8');
  assert.equal(/C12_FORBIDDEN_WORDS = \[/.test(src), false, 'validate.js 不得再自己维护一份词表');
});

test('T38: 提示词已把两条红线约束写进契约(自检拦得住但模型不知道会每天烧修复轮)', () => {
  const r = buildPrompt({ facts: {}, baseline: { horizons: {} }, scorecard: { by_horizon: {} },
    lessons: [], contextTags: [] });
  const contract = r.blocks.find((b) => b.name === 'contract').text;
  assert.match(contract, /第六段[^\n]*阿拉伯数字/);
  assert.match(contract, /一至五段[^\n]*数字/);
});
