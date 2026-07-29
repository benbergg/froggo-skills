'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURE, runCli, freshTmp } = require('./helpers');
const { parseForecast } = require('../references/scripts/forecast-parser');
const R = require('../references/scripts/render');

const bodyOf = (html) => html.split('<body>')[1] || html;   // 整文匹配会误中 <style> 块
const DOC = () => parseForecast(fs.readFileSync(FIXTURE('forecast-good.md'), 'utf-8'));
const SC = () => ({ by_horizon: { short: { n: 25, insufficient_sample: false,
  final: { brier: 0.2377 }, baseline: { brier: 0.2431 }, naive: { brier: 0.2494 } } },
  review_triggers: [], coverage: { expected: 10, settled: 9, skipped: 0, abandoned: 0, approx: 0 } });
const BL = () => ({ base_price: 4022.2, horizons: { short: { low: 3978, high: 4067 } } });
const SP = () => ({ history: [{ date: '2026-07-24', value: 4067.3 }, { date: '2026-07-27', value: 4075 }, { date: '2026-07-28', value: 4022.2 }] });
const RENDER = (over = {}) =>
  R.renderReport({ doc: DOC(), scorecard: SC(), baseline: BL(), settlement: SP(), ...over });

test('T1: 渲染出完整 HTML 且含七段锚点', () => {
  const { html } = RENDER();
  for (const id of ['conclusion', 'facts', 'counterparty', 'reasoning', 'review', 'howto', 'disclaimer']) {
    assert.ok(html.includes(`id="${id}"`), `缺锚点 ${id}`);
  }
});

test('T2: 外部字符串被转义', () => {
  const doc = DOC();
  doc.sections['二'] += '\n<script>alert(1)</script>';
  const { html } = RENDER({ doc });
  assert.equal(bodyOf(html).includes('<script>alert(1)</script>'), false, '归档长期留存,注入脚本会一直在');
  assert.ok(bodyOf(html).includes('&lt;script&gt;'));
});

test('T3: 非 http/https 链接被丢弃', () => {
  assert.equal(R.safeUrl('javascript:alert(1)'), null);
  assert.equal(R.safeUrl('data:text/html,x'), null);
  assert.equal(R.safeUrl('https://example.com/a'), 'https://example.com/a');
});

test('T4: SVG 走势图内联且无外部引用', () => {
  const svg = R.sparkline([1, 2, 3, 2, 4], { width: 300, height: 80 });
  assert.ok(svg.startsWith('<svg'));
  assert.equal(/https?:\/\//.test(svg), false, '不得引外部资源');
  assert.equal(/<script/.test(svg), false);
});

test('T5: 走势图含三期区间带', () => {
  const { html } = RENDER();
  const body = bodyOf(html);
  assert.ok(body.includes('class="band"'), '区间可视化是本报告的核心图');
  // 三期恒全取自 doc.json.horizons —— baseline 的 fixture 只有 short,从它读会漏两期
  for (const k of ['short', 'medium', 'long']) {
    assert.ok(body.includes(`data-h="${k}"`), `缺 ${k} 区间带`);
  }
});

test('T6: 触发器非空时插入定向复核区块', () => {
  const sc = SC();
  sc.review_triggers = [{ kind: 'final_worse_than_baseline', ids: ['2026-07-21', '2026-07-22', '2026-07-23'] }];
  const { html } = RENDER({ scorecard: sc });
  assert.ok(bodyOf(html).includes('定向复核'), '有证据出问题时必须把理由推到眼前');
  assert.ok(bodyOf(html).includes('2026-07-22'), '触发期次必须落地,否则无从 drill-down');
});

test('T7: 触发器为空时不插入该区块', () => {
  const { html } = RENDER();
  assert.equal(bodyOf(html).includes('定向复核'), false, '系统健康时不应打扰');
});

test('T8: 样本不足时不渲染胜率数字', () => {
  const sc = SC();
  sc.by_horizon.short = { n: 8, insufficient_sample: true, final: null, baseline: null, naive: null };
  const { html } = RENDER({ scorecard: sc });
  const body = bodyOf(html);
  assert.ok(body.includes('样本不足'));
  // 只断言提示存在,一个压根不读 insufficient_sample、无条件打印提示的实现也能全绿
  assert.equal(body.includes('57.1%'), false, 'fixture 第五段的胜率建在 8 期样本上,不得呈现');
  assert.equal(body.includes('0.2377'), false, '三方 Brier 对照同样不得呈现');
});

test('T9: 样本充分时不出现「样本不足」', () => {
  const { html } = RENDER();
  const body = bodyOf(html);
  assert.equal(body.includes('样本不足'), false, 'T8 的配对负例:抑制必须真由 insufficient_sample 决定');
  assert.ok(body.includes('57.1%'), '样本充分时统计叙述照常呈现');
});

test('T10: 同步产出 Markdown', () => {
  const { md } = RENDER();
  assert.ok(md.includes('## 一、'));
  assert.ok(md.includes('## 七、'));
  assert.equal(md.includes('```json'), false, 'md = doc.raw 直通也能过前两条,须证明确实做了转换');
  assert.ok(md.includes('## 五、'));
  assert.ok(md.includes('不构成投资建议'), '归档件同样要带免责声明');
});

test('T11: 深浅双主题 token 齐备', () => {
  const { html } = RENDER();
  assert.ok(html.includes('prefers-color-scheme: dark'));
  assert.ok(html.includes("data-theme=\"dark\"") || html.includes("[data-theme='dark']"));
  assert.ok(html.includes('data-theme="light"'), '只覆盖一个方向时,浅色偏好在深色系统下切不回来');
});

test('T12: 含免责声明', () => {
  const { html } = RENDER();
  assert.ok(bodyOf(html).includes('不构成投资建议'));
});

// —— 附录 §2.5:safeUrl 必须真接入正文渲染,零调用者的安全函数是装饰不是防御 ——

test('T13: safeUrl 接入正文链接渲染', () => {
  const doc = DOC();
  doc.sections['二'] += '\n\n延伸阅读 [点此](javascript:void) 与 [文档](https://example.com/b)。';
  const { html } = RENDER({ doc });
  const body = bodyOf(html);
  assert.ok(body.includes('href="https://example.com/a"'), 'fixture 第二段的裸 URL 应成锚点');
  assert.ok(body.includes('href="https://example.com/b"'), 'markdown 链接应成锚点');
  assert.equal(/href="javascript:/.test(body), false);
  assert.equal(body.includes('javascript:void'), false, '危险协议连字面量都不该留在归档里');
  assert.ok(body.includes('点此'), '链接被丢弃后文字仍须保留');
});

// —— 附录 §2.2:先转义原文本、再用标记生成标签,反过来会把自己生成的标签转义成文本 ——

test('T14: 列表与表格转换后是真标签而非转义文本', () => {
  const doc = DOC();
  doc.sections['三'] += '\n\n- 第一条 **重点**\n- 第二条\n\n| 周期 | 区间 |\n| --- | --- |\n| 短期 | 3987-4059 |';
  const { html } = RENDER({ doc });
  const body = bodyOf(html);
  assert.ok(body.includes('<li>第一条 <strong>重点</strong></li>'));
  assert.ok(body.includes('<th>周期</th>') && body.includes('<td>短期</td>'));
  assert.equal(/&lt;(?:li|table|th|td|strong)&gt;/.test(body), false, '转换顺序反了会把自己生成的标签转义掉');
});

// —— 附录 §2.3:抑制与复核同样作用于 md ——

test('T15: md 同受样本不足抑制与定向复核约束', () => {
  const sc = SC();
  sc.review_triggers = [{ kind: 'final_worse_than_baseline', horizon: 'short', ids: ['2026-07-21'] }];
  sc.by_horizon.short = { n: 8, insufficient_sample: true, final: null, baseline: null, naive: null };
  const { md } = RENDER({ scorecard: sc });
  assert.ok(md.includes('定向复核'));
  assert.ok(md.includes('样本不足'));
  assert.equal(md.includes('57.1%'), false, '.md 是归档件,业务规则须与 HTML 一致');
});

// —— 附录 §3:CHART_BRIER 必须画序列,三个标量点连成折线会被读者当趋势记住 ——

test('T16: Brier 演化曲线画的是累积序列而非三个点', () => {
  const sc = SC();
  sc.by_horizon.short.brier_series = Array.from({ length: 25 }, (_, i) => ({
    id: `2026-06-${String(i + 1).padStart(2, '0')}`,
    final: 0.24 - i * 0.001, baseline: 0.245, naive: 0.25,
  }));
  const { html } = RENDER({ scorecard: sc });
  const body = bodyOf(html);
  const m = body.match(/class="ln ln-final" d="([^"]+)"/);
  assert.ok(m, '缺最终模型演化曲线');
  assert.equal((m[1].match(/[ML]/g) || []).length, 25, '顶点数须等于序列长度');
  for (const k of ['ln-baseline', 'ln-naive']) assert.ok(body.includes(k), `缺 ${k} 曲线`);
});

test('T17: 无 brier_series 时不画假曲线', () => {
  const { html } = RENDER();
  assert.equal(bodyOf(html).includes('ln-final'), false, '拿不到序列就该留白,不能拿标量凑一条线');
});

// —— 附录 §1.1:11 项测试全走函数直调,CLI 的 --settlement 缺口不会被发现 ——

test('T18: CLI 跑通并落 html/md 两份产物', () => {
  const dir = freshTmp();
  const p = (n) => path.join(dir, n);
  fs.writeFileSync(p('sc.json'), JSON.stringify(SC()));
  fs.writeFileSync(p('bl.json'), JSON.stringify(BL()));
  fs.writeFileSync(p('sp.json'), JSON.stringify(SP()));
  const r = runCli({ script: 'render.js', args: [
    '--forecast', FIXTURE('forecast-good.md'),
    '--scorecard', p('sc.json'), '--baseline', p('bl.json'), '--settlement', p('sp.json'),
    '--out-html', p('r.html'), '--out-md', p('r.md')] });
  assert.equal(r.code, 0, r.stderr);
  const html = fs.readFileSync(p('r.html'), 'utf-8');
  assert.ok(html.includes('id="conclusion"'));
  assert.ok(html.includes('class="band"'));
  // settlement 真流到了图上:SP() 三个点 ⇒ 价格折线三个顶点
  const pl = html.match(/class="pl" d="([^"]+)"/);
  assert.ok(pl, '缺定盘价折线');
  assert.equal((pl[1].match(/[ML]/g) || []).length, 3);
  assert.ok(fs.readFileSync(p('r.md'), 'utf-8').includes('## 七、'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('T19: CLI 缺 --settlement 直接报错退出', () => {
  const dir = freshTmp();
  const p = (n) => path.join(dir, n);
  fs.writeFileSync(p('sc.json'), JSON.stringify(SC()));
  fs.writeFileSync(p('bl.json'), JSON.stringify(BL()));
  const r = runCli({ script: 'render.js', args: [
    '--forecast', FIXTURE('forecast-good.md'),
    '--scorecard', p('sc.json'), '--baseline', p('bl.json'),
    '--out-html', p('r.html'), '--out-md', p('r.md')] });
  assert.equal(r.code, 1, '静默跑完会等到生产环境才崩在 settlement.history 上');
  assert.ok(/settlement/.test(r.stderr));
  assert.equal(fs.existsSync(p('r.html')), false, '参数不全不得留半成品');
  fs.rmSync(dir, { recursive: true, force: true });
});
