'use strict';
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshTmp } = require('./helpers');
const { HistoryStore } = require('../references/scripts/lib/history-store');
const { predictLogistic } = require('../references/scripts/lib/stats');
const B = require('../references/scripts/baseline');
const BT = require('../references/scripts/backtest');

// 两侧各自独立的抖动。若两边共用同一份抖动,差序列只剩 1 个取值、方差落到 1e-32 量级,
// 无论 lag 取多少 p 恒为 0 —— 那样的夹具对滞后阶完全没有判别力。
const mkSeries = (n, base, freq) => Array.from({ length: n }, (_, i) => base + 0.03 * Math.sin(i * freq));

const varianceOf = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length;
};

// ---- 行情夹具:价格 + 实际利率(日频) + COT(周频),全部当日可见 ----
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function sessionDates(n, start = '2022-01-01') {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// mutateFrom 之后的价格走另一条路径,用于验证「扰动未来不得改变过去的预测」
function seedMarket(store, { n = 600, seed = 7, mutateFrom = null } = {}) {
  const dates = sessionDates(n);
  const rnd = lcg(seed);
  const alt = lcg(seed + 991);
  let px = 1800, y = 0.8, cot = 0;
  const priceRecs = [], dfiiRecs = [], cotRecs = [];
  for (let i = 0; i < n; i++) {
    const u = mutateFrom !== null && i >= mutateFrom ? alt() : rnd();
    y += 0.02 * (u - 0.5);
    if (i % 5 === 0) cot = 0.9 * cot + (u - 0.5);
    px *= 1 + 0.004 * (u - 0.5) + 0.006 * Math.sin(i * 0.37);
    const d = dates[i];
    priceRecs.push({ observed_date: d, available_date: d, vintage: d, value: Number(px.toFixed(2)) });
    dfiiRecs.push({ observed_date: d, available_date: d, vintage: d, value: Number(y.toFixed(4)) });
    if (i % 5 === 0) {
      cotRecs.push({ observed_date: d, available_date: d, vintage: d, value: { net_spec: Math.round(150000 + cot * 20000) } });
    }
  }
  store.upsert('lbma_pm_usd', priceRecs);
  store.upsert('fred_DFII10', dfiiRecs);
  store.upsert('cftc_gold', cotRecs);
  return dates;
}

const SMALL = { warmup: 120, minTrain: 80, refitEvery: 40 };

test('T0: 夹具本身非退化 —— 差序列必须真有方差', () => {
  const a = mkSeries(1300, 0.25, 0.7);
  const b = mkSeries(1300, 0.24, 1.9);
  const v = varianceOf(a.map((x, i) => x - b[i]));
  assert.ok(v > 1e-6, `差序列方差 ${v.toExponential(3)} 过小,该夹具对 lag 无判别力`);
});

test('T1: 改善不足阈值即不通过', () => {
  const r = BT.acceptance({ byHorizon: { short: {
    baselineLoss: mkSeries(1300, 0.2480, 1.9), naiveLoss: mkSeries(1300, 0.2490, 0.7) } } },
  { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.short.checks.samples, true, '样本量应达标,否则测不到 gain 这一条');
  assert.equal(r.short.checks.gain, false, '改善 0.001 < 0.005');
  assert.equal(r.short.passed, false);
});

test('T2: 改善够大且显著才通过', () => {
  const r = BT.acceptance({ byHorizon: { short: {
    baselineLoss: mkSeries(1300, 0.24, 1.9), naiveLoss: mkSeries(1300, 0.25, 0.7) } } },
  { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.short.passed, true);
  assert.ok(r.short.brier_gain >= 0.005);
  assert.ok(r.short.dm_p < 0.05);
});

test('T3: 三条门槛里只有显著性为假时也必须不通过', () => {
  // 旧版这条用 n=60 的夹具,第一个条件 samples 就短路了,p<alpha 这一路从未被走到。
  // 现在显式钉住 samples/gain 皆真、唯独 significance 为假。
  const naiveLoss = Array.from({ length: 1300 }, (_, i) => 0.50 + 0.35 * Math.sin(i * 0.9));
  const baselineLoss = Array.from({ length: 1300 }, (_, i) => 0.49 + 0.35 * Math.sin(i * 2.3));
  const r = BT.acceptance({ byHorizon: { short: { baselineLoss, naiveLoss } } },
    { minGain: 0.005, alpha: 0.05 });
  assert.deepEqual(r.short.checks, { samples: true, gain: true, significance: false },
    `只有显著性该为假,实得 ${JSON.stringify(r.short.checks)} gain=${r.short.brier_gain} p=${r.short.dm_p}`);
  assert.equal(r.short.passed, false, '样本噪声大时不应仅凭均值差放行');
});

test('T4: 未通过的周期给出 fallback 标记', () => {
  const r = BT.acceptance({ byHorizon: { long: {
    baselineLoss: mkSeries(1300, 0.249, 1.9), naiveLoss: mkSeries(1300, 0.2495, 0.7) } } },
  { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.long.passed, false);
  assert.equal(r.long.fallback, 'p0_N');
});

test('T5: 三期各自独立判定', () => {
  const r = BT.acceptance({ byHorizon: {
    short: { baselineLoss: mkSeries(1300, 0.24, 1.9), naiveLoss: mkSeries(1300, 0.25, 0.7) },
    long: { baselineLoss: mkSeries(1300, 0.2495, 1.9), naiveLoss: mkSeries(1300, 0.2500, 0.7) },
  } }, { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.short.passed, true);
  assert.equal(r.long.passed, false, '某期不过不应牵连其他期');
});

test('T6: DM 的 NW 滞后阶取周期长度(重叠窗口自相关长度)', () => {
  assert.equal(BT.lagFor('short'), 1);
  assert.equal(BT.lagFor('medium'), 5);
  assert.equal(BT.lagFor('long'), 20);
});

test('T7: 样本期不足直接判不通过并给出缺口', () => {
  const r = BT.acceptance({ byHorizon: { short: {
    baselineLoss: mkSeries(300, 0.20, 1.9), naiveLoss: mkSeries(300, 0.25, 0.7) } } },
  { minGain: 0.005, alpha: 0.05, minSamples: 1200 });
  assert.equal(r.short.checks.samples, false);
  assert.equal(r.short.samples_short_by, 900, '缺口要写出来,回填不够与模型没信号不能长得一样');
  assert.equal(r.short.passed, false, '样本不足时再漂亮的改善也不可采信');
});

test('T8: 滞后阶必须真正传给 DM,而非仅 lagFor 本身正确', () => {
  // 周期 80 自相关:lag=20 判不显著,若调用处误传 0 则会误判显著
  const period = 80;
  const blk = (i) => (Math.floor(i / period) % 2 === 0 ? 1 : -1);
  const naiveLoss = Array.from({ length: 1300 }, (_, i) => 0.25 + 0.05 * blk(i));
  const baselineLoss = Array.from({ length: 1300 }, (_, i) => 0.24 + 0.001 * Math.sin(i * 2.3));
  const r = BT.acceptance({ byHorizon: { long: { baselineLoss, naiveLoss } } }, { minGain: 0.005, alpha: 0.05 });
  assert.equal(r.long.checks.significance, false, 'lag=20 时本不显著,若显著说明调用处未真正传入 lagFor');
  assert.equal(r.long.passed, false);
});

test('T9: 两侧损失长度不等必须抛错,不得按各自长度取均值', () => {
  // 断言点名 short:光靠 DM 内部那道校验也会抛,但那时 gain 已经按两个不同样本算完了
  assert.throws(() => BT.acceptance({ byHorizon: { short: {
    baselineLoss: mkSeries(100, 0.24, 1.9), naiveLoss: mkSeries(120, 0.25, 0.7) } } }),
  /short 两侧损失长度不等/);
});

test('T10: 损失序列含 NaN 必须抛错,不得静默变成「没通过」', () => {
  const baselineLoss = mkSeries(1300, 0.24, 1.9);
  baselineLoss[700] = NaN;
  assert.throws(() => BT.acceptance({ byHorizon: { short: { baselineLoss, naiveLoss: mkSeries(1300, 0.25, 0.7) } } }),
    /short baselineLoss 第 700 项非有限数/, '报错须点名周期与哪一侧,值班人才不用去猜');
});

test('T11: 可见性游标与 store.read(availableOn) 逐日等价', () => {
  // 这是 walkForward 里那套增量缓存的语义锁:为性能重新引入前视才是真正的风险
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const dates = sessionDates(60);
  const recs = dates.map((d, i) => ({ observed_date: d, available_date: d, vintage: 'v1', value: 100 + i }));
  // 三种迟发修订:晚几天、晚很久、以及同 available_date 的并列版本
  recs.push({ observed_date: dates[10], available_date: dates[20], vintage: 'v2', value: 999 });
  recs.push({ observed_date: dates[10], available_date: dates[40], vintage: 'v3', value: 777 });
  recs.push({ observed_date: dates[30], available_date: dates[31], vintage: 'v2', value: 555 });
  recs.push({ observed_date: dates[45], available_date: dates[45], vintage: 'v2', value: 444 });
  store.upsert('lbma_pm_usd', recs);

  const cursor = new BT.VisibilityCursor(store, 'lbma_pm_usd');
  let diffs = 0;
  for (const d of dates) {
    cursor.advanceTo(d);
    const expected = store.read('lbma_pm_usd', { availableOn: d });
    assert.deepEqual(cursor.rows, expected, `${d} 的可见视图与 store.read 不一致`);
    assert.deepEqual(cursor.values, expected.map((r) => r.value));
    if (expected.some((r) => r.vintage !== 'v1')) diffs++;
  }
  assert.ok(diffs > 0, '夹具须真的含有被修订覆盖的日子,否则这条对拍等于没测');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T12: 窗口中间插入迟发修订,不得改变任何一天的损失', () => {
  // S-C1 的判别式:旧版把 availableOn 取成整个窗口末端 to,窗口内后发的修订
  // 会倒流回每一个更早的预测日。baseline 的 T7 守住了这条性质,backtest 一直没有对应项。
  const build = (withRevision) => {
    const tmp = freshTmp();
    const store = new HistoryStore(tmp);
    const dates = seedMarket(store, { n: 400 });
    const to = dates[dates.length - 1];
    if (withRevision) {
      // 改窗口前 1/3 的一天,available_date 压到窗口末端 —— 任何预测日都不该看到它
      const rows = store.readAll('lbma_pm_usd');
      const victim = rows[150];
      store.upsert('lbma_pm_usd', [{ observed_date: victim.observed_date, available_date: to,
        vintage: 'late-revision', value: Number((victim.value * 1.5).toFixed(2)) }]);
    }
    const res = BT.walkForward({ store, from: dates[0], to, ...SMALL });
    fs.rmSync(tmp, { recursive: true, force: true });
    return res;
  };
  const before = build(false);
  const after = build(true);
  assert.ok(before.byHorizon.short.baselineLoss.length > 100, '样本量太小则这条测不到什么');
  for (const k of ['short', 'medium', 'long']) {
    assert.deepEqual(after.byHorizon[k].dates, before.byHorizon[k].dates, `${k} 评估日集合不应变`);
    assert.deepEqual(after.byHorizon[k].baselineLoss, before.byHorizon[k].baselineLoss,
      `${k} 迟发修订改变了历史损失,说明预测日读的是窗口末端视图`);
    assert.deepEqual(after.byHorizon[k].naiveLoss, before.byHorizon[k].naiveLoss);
  }
  assert.deepEqual(after.coefficients, before.coefficients, '系数同样不得被迟发修订影响');
});

test('T13: 扰动未来不得改变过去任何一天的预测(系数确为 walk-forward 拟合)', () => {
  const CUT = 300;
  const run = (mutateFrom) => {
    const tmp = freshTmp();
    const store = new HistoryStore(tmp);
    const dates = seedMarket(store, { n: 500, mutateFrom });
    const res = BT.walkForward({ store, from: dates[0], to: dates[dates.length - 1], ...SMALL });
    fs.rmSync(tmp, { recursive: true, force: true });
    return { res, cutDate: dates[CUT - 25] };
  };
  const a = run(null);
  const b = run(CUT);
  for (const k of ['short', 'medium', 'long']) {
    const pick = (r) => r.byHorizon[k].dates
      .map((d, i) => ({ d, l: r.byHorizon[k].baselineLoss[i] }))
      .filter((x) => x.d < a.cutDate);
    const pa = pick(a.res), pb = pick(b.res);
    assert.ok(pa.length > 50, `${k} 切点前样本太少(${pa.length}),这条测不出什么`);
    assert.deepEqual(pb, pa, `${k} 改了未来的价格却改变了过去的损失 —— 系数用上了未来数据`);
  }
  // 对照:切点之后确实被改动了,否则上面的相等只是因为夹具压根没变
  const tail = (r, k) => r.byHorizon[k].baselineLoss[r.byHorizon[k].baselineLoss.length - 1];
  assert.notEqual(tail(b.res, 'short'), tail(a.res, 'short'), '扰动未做进夹具,这条测试无效');
});

test('T14: coefficients 与 baseline 消费端严格对齐(跨文件契约)', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const dates = seedMarket(store, { n: 500 });
  const to = dates[dates.length - 1];
  const res = BT.walkForward({ store, from: dates[0], to, ...SMALL });
  // 门槛放开只为拿到三期都发系数的产物,契约本身与门槛无关
  const acc = BT.acceptance(res, { minGain: -1, alpha: 1.1, minSamples: 1 });
  const params = BT.buildParams({ from: dates[0], to, result: res, acc });

  assert.deepEqual(params.features, B.MODEL_FEATURES, 'params.features 即 coefficients 的下标顺序');
  const out = B.computeBaseline({ store, asOf: to, params });
  assert.equal(out.degraded_features.length, 0, '夹具须三特征齐全,否则测不到 logistic 分支');
  for (const k of ['short', 'medium', 'long']) {
    const coef = params.coefficients[k];
    assert.equal(coef.length, B.MODEL_FEATURES.length + 1, `${k} 系数维度须为 截距+特征数`);
    assert.equal(out.horizons[k].model, 'logistic', `${k} 的 logistic 分支不得是死代码`);
    const expected = predictLogistic(coef, B.MODEL_FEATURES.map((f) => out.features[f]));
    assert.equal(out.horizons[k].prob_up, Number(expected.toFixed(4)),
      `${k} 的服务端概率须由同一组系数、同一特征顺序算出`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T15: 只有验收通过的周期才发系数,status 不得被单期通过带偏', () => {
  const result = { coefficients: { short: [1, 2, 3, 4], medium: [5, 6, 7, 8], long: [9, 1, 2, 3] },
    features: B.MODEL_FEATURES, diagnostics: {} };
  const mk = (flags) => Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, { passed: v }]));

  const partial = BT.buildParams({ from: 'a', to: '2026-01-05',
    result, acc: mk({ short: true, medium: false, long: false }) });
  assert.equal(partial.status, 'partial', 'short 单期通过不得把整包标成 accepted');
  assert.deepEqual(Object.keys(partial.coefficients), ['short'],
    '未通过的周期不出现在 coefficients 里,baseline 取不到就自动退回 p0_N');

  const none = BT.buildParams({ from: 'a', to: '2026-01-05', result, acc: mk({ short: false, medium: false, long: false }) });
  assert.equal(none.status, 'fitted');
  assert.equal(none.accepted_at, null, '一期都没过还写 accepted_at 等于给自己发合格证');
  assert.deepEqual(none.coefficients, {});

  const all = BT.buildParams({ from: 'a', to: '2026-01-05', result, acc: mk({ short: true, medium: true, long: true }) });
  assert.equal(all.status, 'accepted');
  assert.equal(all.accepted_at, '2026-01-05');
});

test('T16: from/to 只框评估窗口,窗口外的日子不进损失序列', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const dates = seedMarket(store, { n: 500 });
  const from = dates[300], to = dates[420];
  const res = BT.walkForward({ store, from, to, ...SMALL });
  for (const k of ['short', 'medium', 'long']) {
    const ds = res.byHorizon[k].dates;
    assert.ok(ds.length > 0, `${k} 窗口内应有样本`);
    assert.ok(ds.every((d) => d >= from && d <= to), `${k} 出现窗口外的评估日`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T17: 特征缺失的日子不进评估,而非插补后照跑', () => {
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const dates = sessionDates(500);
  // 只灌价格:cot_pctile 与 real_yield_chg 全程缺失
  store.upsert('lbma_pm_usd', dates.map((d, i) => ({ observed_date: d, available_date: d, vintage: d,
    value: Number((1800 * (1 + 0.0004 * i + 0.01 * Math.sin(i * 0.4))).toFixed(2)) })));
  const res = BT.walkForward({ store, from: dates[0], to: dates[dates.length - 1], ...SMALL });
  for (const k of ['short', 'medium', 'long']) {
    assert.equal(res.byHorizon[k].baselineLoss.length, 0, `${k} 三特征缺两个还能评估,说明又在静默插补`);
  }
  assert.deepEqual(res.coefficients, {}, '拟合不出模型就不该发系数');
  assert.ok(res.diagnostics.skipped_degraded > 300, `降级跳过数须留痕,实得 ${res.diagnostics.skipped_degraded}`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T18: 训练集边界必须精确到「结算日严格早于今天」', () => {
  // T13 只能抓到跨度较大的泄漏(比较区间与扰动区间的边界天然重合)。
  // 这条白盒重算首次拟合的训练集:边界哪怕差一天,系数就对不上。
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const dates = seedMarket(store, { n: 400 });
  const to = dates[dates.length - 1];
  const { warmup, minTrain } = SMALL;
  const spine = store.read('lbma_pm_usd', { availableOn: to }).map((r) => r.observed_date);
  const daily = BT.dailyView(store, spine, warmup);
  const outcomes = BT.realizedOutcomes(store, spine);

  // 比对最后一次拟合(refitEvery=1 时发生在最后一个交易日)。不能比首次拟合:
  // 边界挪一天只让首次拟合早一步发生,训练集内容一模一样,那样比不出差别。
  const n = 1;                        // short
  const last = spine.length - 1 - n - 1;
  const trainX = [], trainY = [];
  for (let j = 0; j <= last; j++) {
    const row = daily.get(j);
    if (row && row.ok && outcomes.short.has(j)) { trainX.push(row.x); trainY.push(outcomes.short.get(j)); }
  }
  assert.ok(trainX.length > minTrain, `训练集只有 ${trainX.length} 条,这条测不出什么`);
  const expected = require('../references/scripts/lib/stats').fitLogistic(trainX, trainY, BT.FIT_OPTS);

  const res = BT.walkForward({ store, from: dates[0], to, warmup, minTrain, refitEvery: 1 });
  assert.deepEqual(res.coefficients.short, expected,
    '系数与「结算日严格早于今天」的训练集算不出同一个值,训练边界被挪动了');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// —— MF-1 止血:训练端与服务端对「落盘过 null 的 FRED 行」必须给同一个结论 ——

test('T19: value 为 null 的 FRED 行在训练端也算特征缺失,不得被 null-null===0 洗成有效值', () => {
  // 训练端曾自写一份 real_yield_chg,与 baseline 各一份。两份在这一点上分叉的后果是
  // 在一个分布上训练、在另一个分布上预测:训练端把常数 0 当有效特征照跑,
  // 服务端判 degraded 退回 p0_N —— 不报错、回测漂亮、实盘失效。
  const tmp = freshTmp();
  const store = new HistoryStore(tmp);
  const dates = sessionDates(500);
  store.upsert('lbma_pm_usd', dates.map((d, i) => ({ observed_date: d, available_date: d, vintage: d,
    value: Number((1800 * (1 + 0.0004 * i + 0.01 * Math.sin(i * 0.4))).toFixed(2)) })));
  store.upsert('fred_DFII10', dates.map((d) => ({ observed_date: d, available_date: d, vintage: d, value: null })));
  const view = BT.dailyView(store, dates, 120);
  const last = view.get(dates.length - 1);
  assert.ok(last, 'dailyView 应产出末日视图');
  const idx = B.MODEL_FEATURES.indexOf('real_yield_chg');
  assert.equal(last.x[idx], null, '训练端也必须判 null,不能是 0');
  assert.equal(last.ok, false, 'null 特征的日子不得进评估');

  // 对照组:同一批日期换成有限值,训练端必须照常算出差值 —— 否则「一律 null」也能过
  const tmp2 = freshTmp();
  const store2 = new HistoryStore(tmp2);
  store2.upsert('lbma_pm_usd', dates.map((d, i) => ({ observed_date: d, available_date: d, vintage: d,
    value: Number((1800 * (1 + 0.0004 * i + 0.01 * Math.sin(i * 0.4))).toFixed(2)) })));
  store2.upsert('fred_DFII10', dates.map((d, i) => ({ observed_date: d, available_date: d, vintage: d,
    value: Number((2 + 0.01 * i).toFixed(4)) })));
  const ok = BT.dailyView(store2, dates, 120).get(dates.length - 1);
  assert.ok(Math.abs(ok.x[idx] - 0.01) < 1e-6, `对照组应算出 0.01,实得 ${ok.x[idx]}`);

  // 训练端与服务端共用同一个实现(各写一份必然漂移)
  assert.equal(B.realYieldChg([{ value: null }, { value: null }]), null);
  assert.equal(B.realYieldChg([{ value: 2.4 }, { value: 2.5 }]).toFixed(4), '0.1000');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
});
