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

test('T18b: 比较语境里的概率阈值不算取值声明,但断言式取值照拦', () => {
  // 首次部署演练实测:M3 写「三档概率均高于 0.5」被 C14 判成「概率提及 ≠ prob_up」,
  // 而要表达这个正确意思就必然写 0.5 ⇒ 第 2/3 轮原样重犯 ⇒ 每天降级、每天多付 3 次模型费。
  const { checkC14 } = require('../references/scripts/validate');
  const base = parseForecast(md('forecast-good.md'));
  const withSent = (s) => { const d = JSON.parse(JSON.stringify(base)); d.sections['一'] = s; return d; };
  const n = (d) => checkC14(d).filter((f) => f.check === 'C14').length;

  assert.equal(n(withSent('三档概率均高于 0.5，方向全为 up。')), 0, '比较语境是阈值,不是在声称某周期的概率');
  assert.equal(n(withSent('短期上涨概率不足 0.90。')), 0, '同上,且真伪由 C4 溯源管');
  assert.ok(n(withSent('短期上涨概率为 0.42。')) > 0, '断言式取值与 JSON 不符必须照拦');
});

test('T18c: 比较词与数字之间夹了名词仍算比较语境', () => {
  // r3 实测:被 T18b 拦下后模型改写成「高于对称值 0.5」,只允许「约/近/空白」的正则就漏了
  const { checkC14 } = require('../references/scripts/validate');
  const base = parseForecast(md('forecast-good.md'));
  const withSent = (s) => { const d = JSON.parse(JSON.stringify(base)); d.sections['一'] = s; return d; };
  assert.equal(checkC14(withSent('三档概率均高于对称值 0.5，方向全为 up。')).length, 0);
  assert.ok(checkC14(withSent('短期上涨概率为 0.42。')).length > 0, '断言式取值仍须照拦');
});

test('T18d: 样本不足时样本量 n 可引用,只有指标不可', () => {
  // 部署首日实测:模型如实写「样本量 n 均为 0…因此无法提供胜率/Brier/Winkler」被 C7 拦,
  // 而这正是设计要第五段做的事。n 不是指标;且 promptScorecard 已把它送进 prompt、
  // C4 认它 —— 两个自检对同一个数字给出相反判断,模型无路可走。
  const { checkC7 } = require('../references/scripts/validate');
  const base = parseForecast(md('forecast-good.md'));
  const ctx = { ...CTX(), scorecard: { by_horizon: {
    short: { insufficient_sample: true, n: 0, final: null, baseline: null, naive: null } } } };
  const withSent = (s) => { const d = JSON.parse(JSON.stringify(base)); d.sections['五'] = s; return d; };
  assert.equal(checkC7(withSent('短期样本量 n 为 0，无法提供胜率、Brier 或 Winkler。'), ctx).length, 0);
  assert.ok(checkC7(withSent('短期胜率为 0.63，Brier 0.21。'), ctx).length > 0,
    '样本不足却报出指标数字仍须照拦');

  // 上一条在 final:null 的夹具下对「守卫还在不在」无判别力 —— 删掉 insufficient_sample
  // 那行照样全绿。反向控制必须让被放宽的那一侧真的有数字可漏。
  const ctxWithStats = { ...CTX(), scorecard: { by_horizon: {
    short: { insufficient_sample: true, n: 3, final: { dir_rate: 0.63 }, baseline: null, naive: null } } } };
  assert.ok(checkC7(withSent('短期胜率为 0.63。'), ctxWithStats).length > 0,
    'insufficient_sample 的周期,其指标即使算得出来也不可引用');
  assert.equal(checkC7(withSent('短期样本量 n 为 3。'), ctxWithStats).length, 0);
});

test('T18e: 段标题漏了 ## 仍能解析,但正文里的枚举行不得被当成段标题', () => {
  // 部署演练实测:M3 时而写「## 一、xxx」时而写裸「一、xxx」(总标题却带 ##),
  // 后者七段全判缺失 ⇒ 三轮空转后降级。内容其实完整,只是 markdown 标记漏了。
  const good = md('forecast-good.md');
  const stripped = good.replace(/^##\s*([一二三四五六七])、/gm, '$1、');
  const d = parseForecast(stripped);
  for (const n of ['一', '二', '三', '四', '五', '六', '七']) {
    assert.ok(d.sections[n] && d.sections[n].length > 0, `裸标题下第${n}段应能解析`);
  }
  assert.deepEqual(parseForecast(good).sections, parseForecast(good).sections);

  // 反向控制:正文中的长句枚举不该抢走段边界
  const trap = good.replace(/^##\s*三、([^\n]*)$/m,
    (m0, h) => `${m0}\n一、这是正文里的一句很长的枚举说明文字，用来验证它不会被误当成段标题抢走边界`);
  const t = parseForecast(trap);
  assert.equal(t.sections['一'], parseForecast(good).sections['一'],
    '正文里的「一、」不得抢走第一段的边界');
  assert.ok(t.sections['三'].includes('这是正文里的一句'), '它应留在第三段正文里');
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

test('T34: 第六段禁的是「红线概念与具体数量同子句」,不是整段禁数量', () => {
  // 正向:一个指令性标记都没有,只有概念 + 数量 —— 唯一能拦它的就是这条判据
  for (const s of ['止损距离取45点。', '止损距离设为20美元。', '杠杆倍数为两倍。']) {
    const f = validate(parseForecast(inject('六', s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `概念与数量同子句未被拦: ${s} -> ${JSON.stringify(f)}`);
  }
  // 反向 a:有概念、无数量 —— 设计 8.1 要求该段讲「怎么自行推算止损距离」
  // 反向 b:有数量、无概念 —— 整段禁数量的写法会把它连带拦下
  for (const s of ['可用波动率区间自行推算止损距离。', '按80%概率区间推算即可。',
    '区间半宽约为45点。']) {
    const f = validate(parseForecast(inject('六', s)), CTX()).findings.filter((x) => x.check === 'C12');
    assert.deepEqual(f, [], `第六段合法说明被误拦: ${s}`);
  }
  // 同一子句才算越界:数量与概念被逗号拆开时不拦(与一–六段的子句口径一致)
  const split = validate(parseForecast(inject('六',
    '区间半宽约为45点，具体风险距离请自行按止损偏好换算。')), CTX()).findings;
  assert.deepEqual(split.filter((x) => x.check === 'C12'), [], '数量与概念分处两个子句不该拦');
});

test('T35: 一–五段按指令性构造判定,免责表述放行', () => {
  for (const s of ['建议仓位控制在2成以内。', '在3978附近买入较为合适。', '止损设在3978。']) {
    const f = validate(parseForecast(inject('四', s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `未被 C12 拦下: ${s} -> ${JSON.stringify(f)}`);
  }
  // 免责表述本身必须放行 —— 否则每天都会因为一句免责话触发修复轮
  const ok = validate(parseForecast(inject('四', '本报告不提供仓位与杠杆建议。')), CTX()).findings;
  assert.deepEqual(ok.filter((x) => x.check === 'C12'), [], '免责表述不该被拦');
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
  // 三处判定(第七段扫描、一–五段指令性构造、第六段档位词)共用一份;各写一份必然漂移
  const D = require('../references/scripts/lib/disclaimer');
  for (const w of ['仓位', '杠杆', '止损', '买卖点位', '买入', '卖出', '加仓', '减仓']) {
    assert.ok(D.REDLINE_WORDS.includes(w), `红线词表缺 ${w}`);
  }
  // REDLINE_WORDS 必须由 A/B 两类拼出,而不是第三份手写清单
  assert.deepEqual(D.REDLINE_WORDS, [...D.REDLINE_SELF_WORDS, ...D.REDLINE_FLOW_WORDS]);
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'references', 'scripts', 'validate.js'), 'utf-8');
  assert.equal(/C12_FORBIDDEN_WORDS = \[/.test(src), false, 'validate.js 不得再自己维护一份词表');
  for (const name of ['REDLINE_DIRECTIVE_MARKERS', 'REDLINE_DESCRIPTIVE_SUBJECTS',
    'REDLINE_NEGATION_MARKERS', 'REDLINE_COMPOUNDS', 'SECTION6_ALLOWED_CONCEPTS']) {
    assert.ok(Array.isArray(D[name]) && D[name].length > 0, `${name} 应在 lib/disclaimer 单点持有`);
    assert.equal(new RegExp(`${name} = \\[`).test(src), false, `validate.js 不得再写一份 ${name}`);
  }
});

test('T38: 提示词已把两条红线约束写进契约(自检拦得住但模型不知道会每天烧修复轮)', () => {
  const r = buildPrompt({ facts: {}, baseline: { horizons: {} }, scorecard: { by_horizon: {} },
    lessons: [], contextTags: [] });
  const contract = r.blocks.find((b) => b.name === 'contract').text;
  assert.match(contract, /第六段[^\n]*阿拉伯数字/);
  // 第六段的中文数量通道:上一版契约恰好把「需要计数」指向中文数字 —— 防线看不见的那一种
  assert.match(contract, /第六段[\s\S]{0,80}中文数量/);
  assert.match(contract, /一至五段[\s\S]{0,120}操作指令/);
  // 契约块 citable:false,新增文案不得带阿拉伯数字(模型看得见却不可引用 = 每天烧一轮修复)
  const lines = contract.split('\n').filter((l) => /第六段|一至五段|价位构造/.test(l));
  assert.equal(/\d/.test(lines.join('')), false, `红线约束文案不得含阿拉伯数字: ${lines.join(' / ')}`);
});

// —— F-2:数字提取入口的全角归一化 ——
// 全角数字对 `\d` 完全不可见,而上一轮把第六段红线也架在同一个 `\d` 上,
// 于是一处编码问题同时关掉 C4 整个溯源层与产品红线。实测同一个编造值:
// `51737` 被 C4 拦下、`５１７３７` 零 findings。

test('T39: 全角数字必须同时对 C4 / 红线 / C14 可见,且不是「见全角就拦」', () => {
  const { checkC4, checkC14, extractNumbers } = require('../references/scripts/validate');
  const base = checkC4(parseForecast(md('forecast-good.md')), CTX()).length;
  const cite = (v) => checkC4(parseForecast(
    md('forecast-good.md').replace(/(## 四、[^\n]*\n\n)/, `$1本段引用一个值 ${v}。\n\n`)), CTX()).length - base;
  // 正向:池里够不到的编造值,半角与全角都必须被 C4 拦下
  assert.ok(cite('51737') > 0, '半角编造值本就该被 C4 拦下');
  assert.ok(cite('５１７３７') > 0, '全角编造值绕过 C4 = 整个溯源层可被一次编码替换关掉');
  // 反向:池里真有的 lbma.pm_usd=4022.2,全角写法必须照旧放行 —— 否则「见全角就拦」也能过正向
  assert.equal(cite('４０２２．２'), 0, '全角写法的真值不得被误拦');
  assert.equal(cite('4022.2'), 0);
  // 归一化落在数字提取的入口,不是各 check 里各写一遍
  assert.deepEqual(extractNumbers('全角 ４０２２．２ 与半角 51737').map((n) => n.numeric), [4022.2, 51737]);
  // 红线两侧同样受益:第六段与一–五段的全角越界句都要拦
  for (const [sec, s] of [['六', '止损位设在３９８７。'], ['六', '４０２２以下买入，４０５９以上卖出。'],
    ['一', '止损设在３９７８。'], ['四', '建议仓位控制在２成以内。']]) {
    const f = validate(parseForecast(inject(sec, s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `全角越界句未被拦: ${sec} ${s}`);
  }
  // C14 的区间路径是 validate.js 里第二个取数点(`RANGE_RE`,不走 extractNumbers)。
  // 取 long 端点冒充短期区间:两个端点都在 C4 池里,所以 C4 结构上抓不到,只有 C14 能拦。
  // 这两条断言删掉 checkC14 里的归一化就会红 —— 而下面那条真值反向控制不会
  // (删掉后全角根本抽不出数字,findings 仍为 0),故它不构成对归一化本身的第二重保险。
  const doc = (s) => parseForecast(md('forecast-good.md').replace(/(## 四、[^\n]*\n\n)/, `$1${s}\n\n`));
  const c14base = checkC14(parseForecast(md('forecast-good.md'))).length;
  const c4base = checkC4(parseForecast(md('forecast-good.md')), CTX()).length;
  const FAKE = '短期区间为3825-4225。';        // 3825/4225 是 long 自己的端点
  const FAKE_FW = '短期区间为３８２５-４２２５。';
  assert.equal(checkC4(doc(FAKE), CTX()).length, c4base, 'C4 结构上抓不到它,这条才是 C14 的存在理由');
  assert.ok(checkC14(doc(FAKE)).length > c14base, '半角的错周期区间本就该被 C14 拦下');
  assert.ok(checkC14(doc(FAKE_FW)).length > c14base,
    '全角错周期区间绕过 C14 = 归一化没做到「唯一入口」');
  assert.equal(checkC14(doc('短期区间为３９８７-４０５９。')).length, c14base, '全角写法的真区间不得被误拦');
});

// —— F-3:一–五段改判「指令性构造」——
// 上一版规则在该拦的地方靠数字形式(改编码就穿透)、在不该拦的地方靠红线词,而央行购金吨数、
// ETF 流向、COT 多空持仓正是设计 8.1 要求第二段必写的内容。实测 8 条描述性市场表述里 7 条
// 被误拦(连免责句自己都被拦)⇒ 正常报告每天触发修复轮 ⇒ 每天降级发布。

test('T40: 描述第三方持仓与流向的市场表述不得误拦', () => {
  const cases = [
    ['二', '各国央行连续9个月净买入黄金，二季度合计买入183吨。'],
    ['二', '全球黄金ETF上周净卖出12.4吨，为近6周首次流出。'],
    ['二', '海外市场去杠杆压力缓解，杠杆资金规模回落约4%。'],
    ['三', 'COMEX投机多头减仓8%，空头同步减仓5%。'],
    ['三', '投机盘仓位处于近三年高位，拥挤度指标为0.43分位。'],
    ['二', '各国央行在4000美元附近继续增持，未见减持迹象。'],
    ['四', '本报告不提供仓位建议，模型仅输出80%概率区间。'],
    ['五', '过去20期中有3期跌破下沿，若当时按下沿止损将全部被扫，故不建议如此使用。'],
    ['四', '若实际利率继续下行，区间中枢将上移，但本模型不据此调整仓位假设。'],
    // 指令性标记与红线概念落在同一句的不同子句 —— 按句判定会误拦,故子句必须切中文逗号
    ['四', '建议读者结合自身情况判断，多头仓位数据于下周公布。'],
  ];
  for (const [sec, s] of cases) {
    const f = validate(parseForecast(inject(sec, s)), CTX()).findings.filter((x) => x.check === 'C12');
    assert.deepEqual(f, [], `设计要求第二段必写的内容被误拦: ${sec} ${s}`);
  }
});

test('T41: 指令性构造必须被拦,含省略主语的祈使句与不带任何数字的纯语义越界', () => {
  const cases = [
    ['二', '目标价4120，跌破3925止损。'],
    ['四', '在3978附近买入较为合适。'],
    ['四', '在4022买入。'],
    ['五', '建议在4022附近分批建仓，止损3978。'],
    ['一', '读者不妨在3978买入。'],
    ['四', '可考虑在4059上方减仓。'],
    ['二', '建议在四千零二十二附近买入，仓位不超过三成。'],
    ['三', '止损距离建议取一倍日波动率。'],
    ['四', '仓位不宜超过三成。'],
    ['四', '建议投资者逢低买入并设置止损。'],
    ['一', '读者可在下沿附近入场，上沿附近离场。'],
    ['五', '应清仓观望，待波动率回落后再建仓。'],
    ['一', '空仓观望为宜。'],
    ['三', '建议满仓持有至月底。'],
  ];
  for (const [sec, s] of cases) {
    const f = validate(parseForecast(inject(sec, s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `越界句未被 C12 拦下: ${sec} ${s} -> ${JSON.stringify(f)}`);
  }
});

test('T42: 免责声明本身绝不能被自己的红线检查拦下', () => {
  // 硬判据。上一版实测「本报告不提供仓位建议，模型仅输出 80% 概率区间」被自己拦下,
  // 而免责句每天都要写 ⇒ 三轮修复耗尽 ⇒ 每天降级发布。
  const { DISCLAIMER_TEXT } = require('../references/scripts/lib/disclaimer');
  for (const sec of ['一', '二', '三', '四', '五', '六']) {
    const f = validate(parseForecast(inject(sec, DISCLAIMER_TEXT)), CTX()).findings.filter((x) => x.check === 'C12');
    assert.deepEqual(f, [], `免责声明注入第${sec}段后被自己的红线拦下`);
  }
  // 带数字的免责句是上一版真正踩到的形态(整句同时含红线词与数字);第六段禁数字故不适用
  for (const sec of ['一', '二', '三', '四', '五']) {
    for (const t of ['本报告不提供仓位建议，模型仅输出80%概率区间。',
      '本报告不提供仓位、杠杆、买卖点位或止损价等具体操作建议，本期区间宽度约1.8%。']) {
      const f = validate(parseForecast(inject(sec, t)), CTX()).findings.filter((x) => x.check === 'C12');
      assert.deepEqual(f, [], `带数字的免责句注入第${sec}段后被拦: ${t}`);
    }
  }
});

test('T43: 第六段禁的是「具体数量」,中文数量与档位词同等对待;非数量的中文连用词放行', () => {
  const { chineseQuantities } = require('../references/scripts/validate');
  for (const s of ['建议在三千九百八十七设置止损。', '仓位控制在三成以内，可用两倍杠杆。',
    '目标价可看至四千一百二十。', '每次入场只用两成资金。', '建议半仓参与，跌破下沿离场。',
    '建议将资金分成三份，每份对应一个价位挂单。']) {
    const f = validate(parseForecast(inject('六', s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `第六段越界句未被拦: ${s}`);
  }
  // 量词表内部的取样:成/点/档/块/元 全在 CN_UNIT_RE 里,配上红线概念必须照拦
  for (const s of ['每档仓位对应一成资金。', '止损距离折算约五十点。']) {
    const f = validate(parseForecast(inject('六', s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `量词表内部的越界写法未被拦: ${s}`);
  }
  // 反向:非数量的中文连用词与约数必须放行,否则第六段每天都在报警
  for (const s of ['区间半宽约为数十点，具体取值随波动率变化，不宜一概而论。',
    '万一价格跌破下沿，应先复核波动率估计是否失真，而非立刻反向操作。',
    '使用方法可分三步：先看方向，再看区间，最后结合自身情况判断。',
    '该方法与第三方研究结论一致，但仍以本报告披露的口径为准。',
    '本区间基于短期波动率分布估算，置信水平与基线模型一致。']) {
    const f = validate(parseForecast(inject('六', s)), CTX()).findings.filter((x) => x.check === 'C12');
    assert.deepEqual(f, [], `第六段合法方法说明被误拦: ${s}`);
  }
  // 反向控制的取样必须落在量词表**内部**:上一版的 7 个反例(数十/几百/第三方/万一/一致/
  // 十分/三步)全部取自实现者自己写的排除机制,于是只能验证「排除清单生效」,永远验证不到
  // 「量词清单过宽」—— 而实测误拦 7/9 正是后者。下列 9 条命中的量词是 点/档/块/元/成,
  // 都在 CN_UNIT_RE 里,且「三成」是仓位的规范写法、「成」删不掉 ⇒ 收窄清单治不了它。
  for (const s of ['波动率并非一成不变，使用前请复核最新估计。',
    '有一点需要说明：区间只描述价格分布，不描述路径。',
    '使用本区间有三点注意事项，均与统计口径有关。',
    '这一点在样本外尤其重要，不可一概而论。',
    '若把区间当成必然边界，就会在极端行情里吃到亏，这一档风险须自行承担。',
    '两者的差异来自波动率估计窗口的不同。',
    '本段说明分为两块：方向的读法与区间的读法。',
    '判断方向时一元化地只看概率是不够的。',
    '区间宽度与周期长度并非线性关系，切勿按倍数直接外推。']) {
    const f = validate(parseForecast(inject('六', s)), CTX()).findings.filter((x) => x.check === 'C12');
    assert.deepEqual(f, [], `普通中文行文被第六段规则误拦: ${s}`);
  }
  // 判据层:量词与位数写法各自独立生效
  assert.deepEqual(chineseQuantities('三成两倍'), ['三', '两']);
  assert.deepEqual(chineseQuantities('三千九百八十七'), ['三千九百八十七']);
  assert.deepEqual(chineseQuantities('数十 几百 第三方 万一 一致 十分 三步'), []);
});

test('T46: 显式指令标记压过反事实豁免;描述性主语豁免只在一–五段生效', () => {
  // 条件式指令是交易建议最标准的写法,原先反事实层排在指令检查之前无条件 continue
  for (const [sec, s] of [['四', '如果你想参与就在3978买入。'], ['五', '假设行情走弱则应当清仓。']]) {
    const f = validate(parseForecast(inject(sec, s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `带指令标记的条件式指令未被拦: ${sec} ${s}`);
  }
  // 反向控制取样落在反事实集**内部**:同样命中 COUNTERFACTUAL_RE,但不带指令标记 ⇒ 照旧豁免
  for (const [sec, s] of [['五', '过去20期中有3期跌破下沿，若当时按下沿止损将全部被扫，故不建议如此使用。'],
    ['四', '若实际利率继续下行，区间中枢将上移，但本模型不据此调整仓位假设。']]) {
    const f = validate(parseForecast(inject(sec, s)), CTX()).findings.filter((x) => x.check === 'C12');
    assert.deepEqual(f, [], `反面警示句被误拦: ${sec} ${s}`);
  }
  // 第六段不需要描述第三方持仓,那层豁免在那里没有存在理由
  for (const s of ['多头趋势未变，半仓参与即可。', '交易商普遍轻仓，跟随他们轻仓操作即可。']) {
    const f = validate(parseForecast(inject('六', s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `第六段借第三方主语夹带的操作指令未被拦: ${s}`);
  }
  // 同一句注入一–五段仍放行(已知局限 8 的「描述性主语」族),这个反差是刻意的而非疏漏
  const s45 = validate(parseForecast(inject('二', '多头趋势未变，半仓参与即可。')), CTX()).findings;
  assert.deepEqual(s45.filter((x) => x.check === 'C12'), [],
    '若这条已被拦下,说明一–五段的描述性主语口径变了,已知局限 8 须同步更新');
  // 反向控制取样落在描述性主语集**内部**:第六段里 B 类词单独出现仍不算指令
  const ok = validate(parseForecast(inject('六', '机构增持并不改变本区间的读法。')), CTX()).findings;
  assert.deepEqual(ok.filter((x) => x.check === 'C12'), [], '第六段的第三方流向描述被误拦');
});

test('T45: 第六段的概念匹配同样先挖空长复合词(取舍已实测,不是顺手写的)', () => {
  // 不挖空的代价:冻结语料里 3 条合法描述性表述(净买入97吨 / 净卖出12.4吨 /
  // 去杠杆…杠杆资金规模)在第六段被误拦;收益只有 1 条真越界(「请将杠杆率提高一档」)。
  // 误拦每天触发修复轮 ⇒ 每天降级发布,故取漏拦这一侧。这条断言在去掉挖空时会红 ——
  // 否则「第六段挖不挖空」在整套 485 项里没有任何判别力(实测)。
  for (const s of ['各国央行三季度合计净买入97吨黄金，创同期新高。',
    '海外市场去杠杆压力缓解，杠杆资金规模回落约4%。']) {
    const f = validate(parseForecast(inject('六', s)), CTX()).findings.filter((x) => x.check === 'C12');
    assert.deepEqual(f, [], `第六段的长复合词被误拦: ${s}`);
  }
  // 代价侧同样钉住,免得半年后误以为它拦得住:复合词把红线概念整词吃掉后无人接手
  const leak = validate(parseForecast(inject('六', '请将杠杆率提高一档。')), CTX()).findings;
  assert.deepEqual(leak.filter((x) => x.check === 'C12'), [],
    '若这条已被拦下,说明挖空口径变了,已知局限 8 的「长复合词挖空」族须同步更新');
});

test('T44: 第六段放过的只有设计要求它讲的那三个概念,其余操作指令照拦', () => {
  const { SECTION6_ALLOWED_CONCEPTS, REDLINE_SELF_WORDS } = require('../references/scripts/lib/disclaimer');
  // 派生而非另写一份清单:允许集必须是红线概念的子集,否则放过的是它自己造出来的词
  for (const w of SECTION6_ALLOWED_CONCEPTS) assert.ok(REDLINE_SELF_WORDS.includes(w), `${w} 不在红线概念里`);
  // 正向:第六段合法地要讲这三个概念(夹具与降级模板都在用),不带数量时必须放行
  const ok = validate(parseForecast(inject('六',
    '如需自行换算止损距离，可参考区间半宽，并结合自身仓位规模与杠杆偏好独立决定。')), CTX()).findings;
  assert.deepEqual(ok.filter((x) => x.check === 'C12'), [], '第六段的方法说明被误拦');
  // 反向:不在允许集里的概念,即便一个数字都不带也要拦
  for (const s of ['建议半仓参与，跌破下沿离场。', '每份资金对应一个价位挂单。', '请在下沿入场。']) {
    const f = validate(parseForecast(inject('六', s)), CTX()).findings;
    assert.ok(f.some((x) => x.check === 'C12'), `第六段的无数字操作指令未被拦: ${s}`);
  }
});
