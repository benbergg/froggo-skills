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
  // 分开断言两个抑制点:只查「样本不足」四个字时,withhold 的提示语会把断言喂饱,
  // 于是「表格分支单独失效」变成零覆盖
  assert.ok(body.includes('样本不足(已结算 8 期)'), '记分卡表格那一行也须抑制');
  assert.ok(body.includes('短周期样本不足'), '第五段叙述须被撤下');
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
  // 曲线只画短周期,而它上方的记分卡表是三行 —— 不标周期读者无从知道画的是哪一行
  const lg = body.match(/<div class="lg">([^<]*)</);
  assert.ok(lg && /短周期/.test(lg[1]), `图例须标周期,实得 ${lg && lg[1]}`);
});

test('T17: 无 brier_series 时不画假曲线', () => {
  const { html } = RENDER();
  assert.equal(bodyOf(html).includes('ln-final'), false, '拿不到序列就该留白,不能拿标量凑一条线');
});

test('T18: 真实 buildScorecard 产物能直接喂出曲线', () => {
  // 前一条用手搓 series,字段名对不上时照样绿 —— 两个模块之间的契约得由真实产物验
  const { buildScorecard } = require('../references/scripts/scorecard');
  const predictions = Array.from({ length: 22 }, (_, i) => ({
    id: `2026-02-${String(i + 1).padStart(2, '0')}`, base_price: 4000,
    horizons: { short: { n_sessions: 1, settled: true, actual: 4010,
      final: { prob_up: 0.58, low: 3950, high: 4050 },
      score: { dir_correct: true, brier: 0.1764, winkler: 100, in_range: true,
        baseline_brier: 0.2209, baseline_winkler: 120, baseline_dir_correct: true,
        naive_brier: 0.2256, naive_p: 0.52 } } },
  }));
  const sc = buildScorecard({ schema_version: 2, predictions, skipped_dates: [] }, {});
  const { html } = RENDER({ scorecard: sc });
  const m = bodyOf(html).match(/class="ln ln-final" d="([^"]+)"/);
  assert.ok(m, 'scorecard 真产的 brier_series 应能画出曲线');
  assert.equal((m[1].match(/[ML]/g) || []).length, 22);
});

// —— 附录 §1.1:11 项测试全走函数直调,CLI 的 --settlement 缺口不会被发现 ——

test('T19: CLI 跑通并落 html/md 两份产物', () => {
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

test('T20: CLI 缺 --settlement 直接报错退出', () => {
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

// —— 修复轮 1:Number(null) === 0 且 isFinite,「没有数据」会被画成「值是 0」 ——

test('T21: brier_series 里的 null 不被当成 0 画进曲线', () => {
  const sc = SC();
  // 前 5 期 baseline 为 null(T37 同款形状:settle.js 在 h.baseline 缺 prob_up 时得 NaN,
  // 落盘即 null),错的实现会画成「量化基线从完美的 Brier 0 起步」
  sc.by_horizon.short.brier_series = Array.from({ length: 25 }, (_, i) => ({
    id: `2026-06-${String(i + 1).padStart(2, '0')}`,
    final: 0.1764, baseline: i < 5 ? null : 0.2209, naive: 0.2256,
  }));
  const { html } = RENDER({ scorecard: sc });
  const body = bodyOf(html);
  const bl = body.match(/class="ln ln-baseline" d="([^"]+)"/);
  assert.ok(bl, '缺基线曲线');
  assert.equal((bl[1].match(/[ML]/g) || []).length, 20, 'null 期不该有顶点');
  assert.equal(bl[1].startsWith('M0.0,'), false, '曲线须从第 6 期起,不能从原点起步');
  const lo = body.match(/class="axis-lbl" x="0" y="158\.0">([\d.]+)</);
  assert.ok(lo, '缺 Y 轴下界标注');
  assert.equal(lo[1], '0.1764', `值域下界被拉到 ${lo[1]} ⇒ 真实信号被压进图高顶部`);
});

test('T22: settlement.history 里的非有限值不被当成 0 画', () => {
  const sp = { history: [
    { date: 'a', value: 4067.3 }, { date: 'b', value: null },
    { date: 'c', value: '' }, { date: 'd', value: 4022.2 }] };
  const { html } = RENDER({ settlement: sp });
  const body = bodyOf(html);
  const pl = body.match(/class="pl" d="([^"]+)"/);
  assert.ok(pl, '缺定盘价折线');
  assert.equal((pl[1].match(/[ML]/g) || []).length, 2, '非有限值须剔除而非落成 0 点');
  // 上游 lbma-gold-pm.js 只判 null/undefined,`v[0] === ""` 会漏过去;
  // 渲染层是归档件最后一道,不该指望上游过滤得精确
  const lo = body.match(/class="axis-lbl" x="0" y="178\.0">([\d.]+)</);
  assert.ok(lo && Number(lo[1]) > 3000, `Y 轴下界被拉到 ${lo && lo[1]},折线一头扎到底`);
});

test('T23: 仅 medium/long 样本不足时,表格是唯一抑制点', () => {
  const sc = SC();
  sc.by_horizon.medium = { n: 12, insufficient_sample: true, final: null, baseline: null, naive: null };
  sc.by_horizon.long = { n: 3, insufficient_sample: true, final: null, baseline: null, naive: null };
  const { html, md } = RENDER({ scorecard: sc });
  const body = bodyOf(html);
  assert.ok(body.includes('57.1%'), 'withhold=false,短周期叙述照常呈现');
  assert.equal(body.includes('短周期样本不足'), false, '此场景不该走整段撤下那条路');
  assert.equal((body.match(/样本不足\(已结算/g) || []).length, 2, 'medium/long 各一个抑制单元');
  assert.ok(body.includes('样本不足(已结算 12 期)') && body.includes('样本不足(已结算 3 期)'));
  assert.equal(md.includes('样本不足(已结算 12 期)'), true, 'md 侧同一条规则');
});

// —— 修复轮 1(可选项):强调标记注入 href 与裸 URL 吞转义实体 ——

test('T24: 强调标记不注入 href', () => {
  const doc = DOC();
  doc.sections['三'] += '\n\n参见 [示例 **要点**](https://example.com/d?q=1) 结束。';
  const { html } = RENDER({ doc });
  const body = bodyOf(html);
  assert.ok(body.includes('href="https://example.com/d?q=1"'),
    `href 被污染: ${body.match(/href="[^"]*example[^"]*"/g)}`);
  assert.equal(/href="[^"]*(?:<|&lt;)/.test(body), false, 'href 里出现标签 ⇒ 链接失效');
  assert.ok(body.includes('<strong>要点</strong>'), '链接文字里的强调仍要生效');
});

test('T25: 裸 URL 不把转义实体吞进 href', () => {
  const doc = DOC();
  doc.sections['三'] += '\n\n他说"https://example.com/c"随后离开。';
  const { html } = RENDER({ doc });
  const body = bodyOf(html);
  assert.ok(body.includes('href="https://example.com/c"'),
    `href 吞进了实体: ${body.match(/href="[^"]*example\.com\/c[^"]*"/g)}`);
  assert.ok(body.includes('&quot;随后离开'), '截断后的余下部分退回普通文本');
});
