'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshTmp, FIXTURE } = require('./helpers');
const C = require('../references/scripts/commit');
const P = require('../references/scripts/push');

// 记分卡夹具按 buildScorecard 的真实不变量构造:三个 HORIZONS 键恒在,
// 样本不足时降级为 insufficient_sample 而**绝不缺键**。计划原稿只给 short 一个键,
// 照它写会逼出一堆从未对着真实形状验证过的 `?.` 防御。
const SC_FULL = {
  by_horizon: {
    short: {
      n: 25, insufficient_sample: false,
      final: { dir_rate: 0.571, brier: 0.2377 },
      baseline: { dir_rate: 0.558, brier: 0.2431 },
      naive: { dir_rate: 0.525, brier: 0.2494 },
    },
    medium: { n: 12, insufficient_sample: true, final: null, baseline: null, naive: null },
    long: { n: 4, insufficient_sample: true, final: null, baseline: null, naive: null },
  },
};

const DOC_FULL = {
  json: {
    horizons: {
      short: { prob_up: 0.58, direction: 'up', low: 3987, high: 4059 },
      medium: { prob_up: 0.55, direction: 'up', low: 3922, high: 4124 },
      long: { prob_up: 0.60, direction: 'up', low: 3818, high: 4234 },
    },
  },
};

const SCRIPT = (name) => path.join(__dirname, '..', 'references', 'scripts', name);

function runScript(script, args, { home, env = {} }) {
  const r = spawnSync('node', [SCRIPT(script), ...args], {
    encoding: 'utf-8', cwd: home, timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: home, ...env },
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// —— commit.js:入库幂等 ——

test('T1: 同 id 写入为覆盖而非追加', () => {
  let db = { schema_version: 2, predictions: [{ id: '2026-07-29', base_price: 1 }], skipped_dates: [] };
  const r = C.upsertPrediction(db, { id: '2026-07-29', base_price: 2 });
  assert.equal(r.action, 'updated');
  assert.equal(r.db.predictions.length, 1, '重跑不得产生重复记录');
  assert.equal(r.db.predictions[0].base_price, 2);
});

test('T2: 新 id 追加', () => {
  const db = { schema_version: 2, predictions: [{ id: '2026-07-28' }], skipped_dates: [] };
  const r = C.upsertPrediction(db, { id: '2026-07-29' });
  assert.equal(r.action, 'inserted');
  assert.equal(r.db.predictions.length, 2);
});

test('T3: predictions 保持按 id 升序', () => {
  const db = { schema_version: 2, predictions: [{ id: '2026-07-29' }], skipped_dates: [] };
  const r = C.upsertPrediction(db, { id: '2026-07-28' });
  assert.deepEqual(r.db.predictions.map((p) => p.id), ['2026-07-28', '2026-07-29']);
});

test('T4: 索引按年分页', () => {
  const entries = [{ id: '2025-03-01' }, { id: '2026-07-28' }, { id: '2026-07-29' }];
  const html = C.buildIndex(entries, { year: 2026 });
  assert.ok(html.includes('2026-07-29'));
  assert.ok(html.includes('2026-07-28'), '当年条目一条都不能漏');
  assert.equal(html.includes('2025-03-01'), false, '不分页会无限膨胀');
});

test('T5: 索引含年份切换链接', () => {
  const html = C.buildIndex([{ id: '2025-03-01' }, { id: '2026-07-29' }], { year: 2026 });
  assert.ok(html.includes('2025'), '需能跳回其他年份');
  // 只验「2025 这四个数字出现过」测不出链接可用:href 必须指向该年的归档页
  assert.ok(html.includes(`href="${C.indexFileName(2025)}"`), '年份链接须指向对应年份的索引页');
  assert.equal(html.includes(`href="${C.indexFileName(2026)}"`), false, '当前页不应链回自己');
});

// —— 推送幂等 ——

test('T6: 同内容不重复发送', () => {
  const tmp = freshTmp();
  const h = P.messageHash({ id: '2026-07-29', text: 'abc' });
  assert.equal(P.alreadySent(tmp, h), false);
  P.markSent(tmp, h);
  assert.equal(P.alreadySent(tmp, h), true, 'cron 重试会导致重复推送');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T7: 内容变化则视为新消息', () => {
  const a = P.messageHash({ id: '2026-07-29', text: 'abc' });
  const b = P.messageHash({ id: '2026-07-29', text: 'abd' });
  assert.notEqual(a, b);
});

test('T8: 摘要含三期与结算,不含仓位建议', () => {
  const s = P.buildSummary({ doc: DOC_FULL, scorecard: SC_FULL, url: 'https://example.com/r.html' });
  assert.ok(s.includes('3987'));
  assert.ok(s.includes('https://example.com/r.html'));
  assert.equal(/仓位|杠杆|止损|建议买入|建议卖出/.test(s), false, '摘要不得越界给交易指令');
  // 样本充足时短期那一行必须报出数字。整篇 includes('样本不足') 会被 medium/long 那两行
  // 顶成恒真,断言必须按行锚定到短期。
  assert.equal(/短期[^\n]*样本不足/.test(s), false, '样本充足却撤下胜率等于白算');
  assert.ok(/短期[^\n]*57\.1%/.test(s), '短期方向胜率须呈现');
});

test('T9: 样本不足时摘要不报胜率数字', () => {
  const s = P.buildSummary({
    doc: { json: { horizons: { short: { prob_up: 0.58, direction: 'up', low: 1, high: 2 },
                               medium: { prob_up: 0.5, direction: 'up', low: 1, high: 2 },
                               long: { prob_up: 0.5, direction: 'up', low: 1, high: 2 } } } },
    scorecard: { by_horizon: {
      short: { n: 8, insufficient_sample: true, final: null, baseline: null, naive: null },
      medium: { n: 3, insufficient_sample: true, final: null, baseline: null, naive: null },
      long: { n: 0, insufficient_sample: true, final: null, baseline: null, naive: null },
    } },
    url: 'https://example.com/r.html',
  });
  assert.ok(s.includes('样本不足'));
  assert.ok(/短期[^\n]*样本不足/.test(s), '短期样本不足须落在短期那一行');
  assert.equal(/\d+\.\d%/.test(s.split('\n').filter((l) => l.includes('胜率')).join('\n')), false,
    '样本不足时不得出现胜率百分数');
});

test('T10: 失败简报注明结算是否已完成', () => {
  const a = P.buildFailureBrief({ step: 'validate', code: 5, settled: true });
  assert.ok(a.includes('结算已完成'), '否则用户会误以为统计断档');
  const b = P.buildFailureBrief({ step: 'collect-settlement', code: 4, settled: false });
  assert.ok(b.includes('结算未完成'));
});

test('T11: 失败简报标题与正常报告可区分', () => {
  const f = P.buildFailureBrief({ step: 'validate', code: 5, settled: true });
  assert.ok(/失败|异常/.test(f.split('\n')[0]));
});

// —— 以下为 brief 之外补充的判别力覆盖 ——

test('T12: upsert 为整条覆盖而非字段合并', () => {
  const db = { schema_version: 2, skipped_dates: [],
    predictions: [{ id: '2026-07-29', base_price: 1, stale_field: '旧版残留' }] };
  const r = C.upsertPrediction(db, { id: '2026-07-29', base_price: 2 });
  assert.equal('stale_field' in r.db.predictions[0], false,
    '只有通过自检的产物才走到这里,覆盖的一定更完整;合并会让旧版残留字段永生');
});

test('T13: upsert 原样接住上游装配的全部字段,且不改写入参', () => {
  // naive_p / c9_triggered / target_date 由 Task 15 的 buildPredictionRecord 装配,
  // commit 只搬运 —— 丢一个字段就等于结算或触发器统计静默失效。
  const record = { id: '2026-07-29', base_date: '2026-07-28', base_price: 4022.2,
    model_id: 'minimax/MiniMax-M3', degraded: false, c9_triggered: true,
    context_tags: ['pre_cpi'], cited_lessons: ['L003'],
    horizons: { short: { n_sessions: 1, target_date: '2026-07-29', naive_p: 0.52,
      final: { prob_up: 0.58, low: 3987, high: 4059 } } } };
  const snapshot = JSON.parse(JSON.stringify(record));
  const r = C.upsertPrediction({ schema_version: 2, predictions: [], skipped_dates: [] }, record);
  assert.deepEqual(r.db.predictions[0], snapshot, '不得丢字段');
  assert.deepEqual(record, snapshot, '不得改写调用方的 record');
});

test('T14: upsert 拒绝非法 id', () => {
  const db = { schema_version: 2, predictions: [], skipped_dates: [] };
  assert.throws(() => C.upsertPrediction(db, { base_price: 1 }), /id/,
    'id 是覆盖主键与分年依据,缺失时静默追加会造出永不被覆盖的幽灵记录');
  assert.throws(() => C.upsertPrediction(db, { id: '2026/07/29' }), /id/);
});

test('T15: 索引对未结算条目照常成行', () => {
  // 三期里 medium/long 长期处于 settled:false,score 缺失是契约内的正常形态
  const html = C.buildIndex([{ id: '2026-07-29', base_price: 4022.2,
    horizons: { short: { final: { prob_up: 0.58, low: 3987, high: 4059 } } } }], { year: 2026 });
  assert.ok(html.includes('2026-07-29'));
  assert.ok(html.includes('4022.2'));
  assert.ok(html.includes('看涨'));
});

test('T16: 索引转义外部字符串', () => {
  const html = C.buildIndex([{ id: '2026-07-29', model_id: '<script>alert(1)</script>' }], { year: 2026 });
  assert.equal(html.includes('<script>alert(1)</script>'), false, '归档躺很多年,注入的脚本会一直在');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('T17: 索引数字不带千分位', () => {
  const html = C.buildIndex([{ id: '2026-07-29', base_price: 12345.6 }], { year: 2026 });
  assert.ok(html.includes('12345.6'));
  assert.equal(html.includes('12,345.6'), false, 'toLocaleString 的逗号会打断下游子串匹配');
});

test('T18: buildIndex 必须显式传 year', () => {
  assert.throws(() => C.buildIndex([{ id: '2026-07-29' }], {}), /year/,
    '缺省成「全部年份」会让分页形同虚设,且不报错所以永不被发现');
});

test('T19: 同 payload 的哈希稳定', () => {
  const p = { id: '2026-07-29', text: 'abc' };
  assert.equal(P.messageHash(p), P.messageHash({ ...p }), '哈希不稳定则去重恒失效');
});

test('T20: 发送记录上限 200 条且保留最近的', () => {
  const tmp = freshTmp();
  for (let i = 0; i < 210; i++) P.markSent(tmp, `h${String(i).padStart(4, '0')}`);
  const cur = JSON.parse(fs.readFileSync(path.join(tmp, 'sent.json'), 'utf-8'));
  assert.equal(cur.hashes.length, 200);
  assert.equal(P.alreadySent(tmp, 'h0209'), true, '最近一条必须还在');
  assert.equal(P.alreadySent(tmp, 'h0000'), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T21: 摘要含三期区间上下沿与归档链接', () => {
  const s = P.buildSummary({ doc: DOC_FULL, scorecard: SC_FULL, url: 'https://example.com/r.html' });
  for (const v of ['3987', '4059', '3922', '4124', '3818', '4234']) {
    assert.ok(s.includes(v), `缺少区间端点 ${v}`);
  }
  assert.ok(/中期[^\n]*55\.0%/.test(s));
  assert.equal(/失败|异常/.test(s.split('\n')[0]), false, '正常摘要标题不得与失败简报混淆');
});

test('T22: 记分卡缺周期键时摘要不抛错,且不冒充样本不足', () => {
  // 与 T8/T9 的三键齐全形态互补:缺键是「记分卡本身没算出来」,与「样本不够」
  // 是两种故障,混为一谈会让前者永远查不出来。
  const s = P.buildSummary({
    doc: DOC_FULL,
    scorecard: { by_horizon: { short: SC_FULL.by_horizon.short } },
    url: 'https://example.com/r.html',
  });
  assert.ok(/短期[^\n]*57\.1%/.test(s));
  const mid = s.split('\n').find((l) => l.startsWith('中期') && !l.includes('区间'));
  assert.ok(mid, '缺键的周期也要成行,不能整行消失');
  assert.equal(mid.includes('样本不足'), false);
});

test('T23: 失败简报含步骤、退出码与连续失败天数', () => {
  const f = P.buildFailureBrief({ step: 'validate', code: 5, settled: true, consecutive: 3, date: '2026-07-29' });
  assert.ok(f.includes('validate'));
  assert.ok(f.includes('5'));
  assert.ok(f.includes('2026-07-29'));
  assert.ok(f.includes('3'), '连续失败天数是「偶发还是坏了」的唯一线索');
  const g = P.buildFailureBrief({ step: 'validate', code: 5, settled: true });
  assert.equal(/连续失败/.test(g), false, '未提供时不得编造天数');
});

// —— CLI 端到端 ——

function seedCommitInputs(home) {
  const record = { id: '2026-07-29', base_date: '2026-07-28', base_price: 4022.2,
    model_id: 'minimax/MiniMax-M3', degraded: false,
    horizons: { short: { n_sessions: 1, target_date: '2026-07-29',
      final: { prob_up: 0.58, low: 3987, high: 4059 }, settled: false } } };
  fs.writeFileSync(path.join(home, 'record.json'), JSON.stringify(record));
  fs.writeFileSync(path.join(home, 'r.html'), '<p>报告正文</p>');
  fs.writeFileSync(path.join(home, 'r.md'), '# 报告正文');
  fs.writeFileSync(path.join(home, 'scorecard.json'), JSON.stringify(SC_FULL));
  return record;
}

test('T24: commit CLI 入库、归档、建索引、备份,且重跑幂等', () => {
  const home = freshTmp();
  seedCommitInputs(home);
  const args = ['--record', 'record.json', '--archive-dir', 'arch',
    '--report-html', 'r.html', '--report-md', 'r.md', '--scorecard', 'scorecard.json'];
  const a = runScript('commit.js', args, { home });
  assert.equal(a.code, 0, a.stderr);

  const dbPath = path.join(home, '.local', 'state', 'gold-forecast', 'predictions.json');
  assert.equal(JSON.parse(fs.readFileSync(dbPath, 'utf-8')).predictions.length, 1);
  assert.equal(fs.readFileSync(path.join(home, 'arch', '2026-07-29.html'), 'utf-8'), '<p>报告正文</p>');
  assert.equal(fs.readFileSync(path.join(home, 'arch', '2026-07-29.md'), 'utf-8'), '# 报告正文');
  assert.ok(fs.existsSync(path.join(home, 'arch', 'index.html')), '设计 §8 要求 index.html 存在');
  assert.ok(fs.existsSync(path.join(home, 'arch', C.indexFileName(2026))));
  assert.ok(fs.existsSync(path.join(home, 'arch', '_data', 'scorecard.json')));
  // 备份是唯一恢复源,位于同步范围之外
  assert.ok(fs.existsSync(path.join(home, 'backup', 'gold-forecast', 'predictions.json')));

  const b = runScript('commit.js', args, { home });
  assert.equal(b.code, 0, b.stderr);
  assert.equal(JSON.parse(fs.readFileSync(dbPath, 'utf-8')).predictions.length, 1, '重跑不得追加');
  fs.rmSync(home, { recursive: true, force: true });
});

test('T25: commit CLI 缺归档目录即报错,不猜路径', () => {
  const home = freshTmp();
  seedCommitInputs(home);
  const r = runScript('commit.js', ['--record', 'record.json'], { home });
  assert.equal(r.code, 1);
  assert.ok(/archive-dir/.test(r.stderr), '默认写进知识库会在测试里污染真实 vault');
  fs.rmSync(home, { recursive: true, force: true });
});

test('T26: commit CLI 不产生 versions 目录', () => {
  const home = freshTmp();
  seedCommitInputs(home);
  runScript('commit.js', ['--record', 'record.json', '--archive-dir', 'arch',
    '--report-html', 'r.html', '--report-md', 'r.md'], { home });
  runScript('commit.js', ['--record', 'record.json', '--archive-dir', 'arch',
    '--report-html', 'r.html', '--report-md', 'r.md'], { home });
  assert.equal(fs.existsSync(path.join(home, 'arch', 'versions')), false,
    '归档件可由 predictions.json 重算,版本副本只会被同步进知识库当垃圾');
  fs.rmSync(home, { recursive: true, force: true });
});

test('T31: 备份失败即退非零,不静默放过', () => {
  const home = freshTmp();
  seedCommitInputs(home);
  const bad = path.join(home, 'rsync-fail');
  fs.writeFileSync(bad, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(bad, 0o755);
  const r = runScript('commit.js', ['--record', 'record.json', '--archive-dir', 'arch'],
    { home, env: { GOLD_RSYNC_BIN: bad } });
  assert.equal(r.code, 3, '备份是唯一恢复源,失败静默 exit 0 等于以为备着其实没备');
  assert.ok(/备份失败/.test(r.stderr));
  // 入库先于备份,故此时权威库应已写好 —— 重跑幂等,不需要回滚
  assert.ok(fs.existsSync(path.join(home, '.local', 'state', 'gold-forecast', 'predictions.json')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('T32: 备份只增不减,不传导权威目录的删除', () => {
  const home = freshTmp();
  seedCommitInputs(home);
  const backup = path.join(home, 'backup', 'gold-forecast');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'old-predictions.json'), '{"predictions":[]}');
  const r = runScript('commit.js', ['--record', 'record.json', '--archive-dir', 'arch'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(backup, 'old-predictions.json')),
    'rsync 加 --delete 会让权威目录被误删后一次同步抹平恢复源');
  fs.rmSync(home, { recursive: true, force: true });
});

// 上期已结算一条 + 本期未结算一条,即 push 时 predictions.json 的真实形态
// (commit 是 Step 6、push 是 Step 7,当天记录此刻已经入库但 short 尚未结算)
const DB_SETTLED = { schema_version: 2, skipped_dates: [], predictions: [
  { id: '2026-07-28', base_price: 4010.5, horizons: { short: {
    final: { prob_up: 0.58, low: 3987, high: 4059 }, settled: true, settled_date: '2026-07-29',
    settled_kind: 'exact', actual: 4048.6, score: { dir_correct: true, brier: 0.1764 } } } },
  { id: '2026-07-29', base_price: 4022.2, horizons: { short: {
    final: { prob_up: 0.55, low: 3990, high: 4060 }, settled: false } } },
] };

function seedPushInputs(home) {
  fs.copyFileSync(FIXTURE('forecast-good.md'), path.join(home, 'forecast.md'));
  fs.writeFileSync(path.join(home, 'scorecard.json'), JSON.stringify(SC_FULL));
  fs.writeFileSync(path.join(home, 'predictions.json'), JSON.stringify(DB_SETTLED));
  const stub = path.join(home, 'openclaw-stub');
  // 调用次数与参数分两个文件记:消息正文本身是多行的,拿行数当次数会一次调用记成好几次
  fs.writeFileSync(stub, ['#!/bin/sh', 'echo CALL >> "$HOME/calls.log"',
    'printf \'%s\\n\' "$*" >> "$HOME/args.log"', 'exit ${STUB_EXIT:-0}', ''].join('\n'));
  fs.chmodSync(stub, 0o755);
  return stub;
}

const pushArgs = ['--mode', 'report', '--forecast', 'forecast.md', '--scorecard', 'scorecard.json',
  '--predictions', 'predictions.json', '--url', 'https://example.com/r.html', '--date', '2026-07-29'];

const callCount = (home) => {
  const f = path.join(home, 'calls.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter((l) => l === 'CALL').length : 0;
};

const argsLog = (home) => {
  const f = path.join(home, 'args.log');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '';
};

test('T27: push CLI 默认 dry-run,且 dry-run 不记账', () => {
  const home = freshTmp();
  const stub = seedPushInputs(home);
  const env = { OPENCLAW_BIN: stub, GOLD_FEISHU_TARGET: 'ou_x' };
  const a = runScript('push.js', pushArgs, { home, env });
  assert.equal(a.code, 0, a.stderr);
  assert.ok(argsLog(home).includes('--dry-run'), 'SEND_NOTIFY 未开启时不得真发');

  const b = runScript('push.js', pushArgs, { home, env });
  assert.equal(b.code, 0, b.stderr);
  assert.equal(callCount(home), 2, '演练记账会让当天真发被永久顶掉');
  fs.rmSync(home, { recursive: true, force: true });
});

test('T28: push CLI 真发后同内容跳过', () => {
  const home = freshTmp();
  const stub = seedPushInputs(home);
  const env = { OPENCLAW_BIN: stub, GOLD_FEISHU_TARGET: 'ou_x', SEND_NOTIFY: '1' };
  const a = runScript('push.js', pushArgs, { home, env });
  assert.equal(a.code, 0, a.stderr);
  assert.equal(argsLog(home).includes('--dry-run'), false);
  assert.ok(argsLog(home).includes('--account'),
    '本机装了多个飞书账号,漏传 --account 会被拒 open_id cross app');

  const b = runScript('push.js', pushArgs, { home, env });
  assert.equal(b.code, 0, b.stderr);
  assert.equal(callCount(home), 1, 'cron 重试不得重复推送');
  fs.rmSync(home, { recursive: true, force: true });
});

test('T29: push CLI 发送失败退非零且不记账', () => {
  const home = freshTmp();
  const stub = seedPushInputs(home);
  const env = { OPENCLAW_BIN: stub, GOLD_FEISHU_TARGET: 'ou_x', SEND_NOTIFY: '1', STUB_EXIT: '3' };
  const a = runScript('push.js', pushArgs, { home, env });
  assert.equal(a.code, 4, '发送失败静默 exit 0 等于该报警时没报警');
  const b = runScript('push.js', pushArgs, { home, env: { ...env, STUB_EXIT: '0' } });
  assert.equal(b.code, 0, b.stderr);
  assert.equal(callCount(home), 2, '失败不得被记进已发送');
  fs.rmSync(home, { recursive: true, force: true });
});

test('T30: push CLI 失败简报走同一去重通道', () => {
  const home = freshTmp();
  const stub = seedPushInputs(home);
  const env = { OPENCLAW_BIN: stub, GOLD_FEISHU_TARGET: 'ou_x', SEND_NOTIFY: '1' };
  const args = ['--mode', 'failure', '--step', 'validate', '--code', '5',
    '--settled', '1', '--date', '2026-07-29'];
  assert.equal(runScript('push.js', args, { home, env }).code, 0);
  assert.equal(runScript('push.js', args, { home, env }).code, 0);
  assert.equal(callCount(home), 1);
  assert.ok(/失败|异常/.test(argsLog(home)));
  fs.rmSync(home, { recursive: true, force: true });
});

// —— 修复轮 1:告警通道不能有单点 / 跨天去重 / 上期结算 / 权威库保护 ——

test('T33: sent.json 损坏时不瘫死,降级为空并 WARN', () => {
  const tmp = freshTmp();
  fs.writeFileSync(path.join(tmp, 'sent.json'), '{"hashes":["deadbeef"');   // cron kill / OOM 的半截文件
  assert.equal(P.alreadySent(tmp, 'deadbeef'), false, '裸 JSON.parse 会让此后每条消息都发不出去');
  assert.deepEqual(P.readSent(tmp), []);
  P.markSent(tmp, 'cafe0001');   // 损坏文件必须能被覆盖修好
  assert.equal(P.alreadySent(tmp, 'cafe0001'), true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T34: hashes 非数组时不退化成子串匹配', () => {
  const tmp = freshTmp();
  fs.writeFileSync(path.join(tmp, 'sent.json'), JSON.stringify({ hashes: 'deadbeefcafe' }));
  // 字符串也有 .includes():不校验类型会把「已发送」误判成 true,静默漏发
  assert.equal(P.alreadySent(tmp, 'beef'), false);
  assert.equal(P.alreadySent(tmp, 'deadbeefcafe'), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T35: 损坏的 sent.json 不阻断真实推送,且退出码不与参数错混淆', () => {
  const home = freshTmp();
  const stub = seedPushInputs(home);
  const state = path.join(home, '.local', 'state', 'gold-forecast');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'sent.json'), '{"hashes":["deadbeef"');
  const env = { OPENCLAW_BIN: stub, GOLD_FEISHU_TARGET: 'ou_x', SEND_NOTIFY: '1' };
  const r = runScript('push.js', pushArgs, { home, env });
  assert.equal(r.code, 0, '告警通道自己不能有单点:损坏的去重记录不得变成推送总闸');
  assert.equal(callCount(home), 1);
  assert.ok(/WARN/.test(r.stderr), '降级必须刺眼,静默会让「去重失效」也无人知晓');

  // 运行期异常(读不到输入文件)必须与 exit 1(参数错)分开
  const bad = runScript('push.js', ['--mode', 'report', '--forecast', 'nope.md',
    '--scorecard', 'scorecard.json', '--predictions', 'predictions.json'], { home, env });
  assert.equal(bad.code, 5);
  assert.equal(runScript('push.js', ['--mode', 'bogus'], { home, env }).code, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('T36: sent.json 走原子写路径,不留临时文件也不堆版本副本', () => {
  // 「崩在写入中途」的时间窗测不到,故这里锁的是「写入确实走 atomicWriteJSON」:
  // 两次写不得长出 versions/(默认 keepVersions=30 会),写完不得留 .tmp.,
  // 且目标文件只读时仍能更新 —— rename 只要目录可写,裸 writeFileSync 会 EACCES。
  const tmp = freshTmp();
  P.markSent(tmp, 'aaaa1111');
  P.markSent(tmp, 'bbbb2222');
  assert.deepEqual(P.readSent(tmp), ['aaaa1111', 'bbbb2222']);
  assert.equal(fs.existsSync(path.join(tmp, 'versions')), false, '去重记录不需要版本副本');
  assert.equal(fs.readdirSync(tmp).filter((f) => f.includes('.tmp.')).length, 0, '临时文件须已 rename');

  fs.chmodSync(path.join(tmp, 'sent.json'), 0o444);
  P.markSent(tmp, 'cccc3333');
  assert.ok(P.readSent(tmp).includes('cccc3333'), '原子写靠 rename 落地,不就地改写目标文件');
  fs.chmodSync(path.join(tmp, 'sent.json'), 0o644);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T37: failure 简报缺 --date 时落挂钟日期', () => {
  const home = freshTmp();
  const stub = seedPushInputs(home);
  const r = runScript('push.js', ['--mode', 'failure', '--step', 'validate', '--code', '5', '--settled', '1'],
    { home, env: { OPENCLAW_BIN: stub, GOLD_FEISHU_TARGET: 'ou_x', SEND_NOTIFY: '1' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(argsLog(home).includes(P.todayLocal()), '正文无随日期变化的成分,跨天告警会被自己的去重吞掉');
  assert.equal(argsLog(home).includes('未标注日期'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('T38: 不同日期的同类失败视为不同消息', () => {
  const base = { step: 'validate', code: 5, settled: true };
  const a = P.buildFailureBrief({ ...base, date: '2026-07-29' });
  const b = P.buildFailureBrief({ ...base, date: '2026-07-30' });
  assert.notEqual(P.messageHash({ mode: 'failure', date: '2026-07-29', text: a }),
    P.messageHash({ mode: 'failure', date: '2026-07-30', text: b }),
    '「连挂三天」必须收到三条,不是一条');
});

test('T39: 摘要含上期单条结算复盘', () => {
  const s = P.buildSummary({ doc: DOC_FULL, scorecard: SC_FULL, url: 'https://example.com/r.html',
    lastSettled: P.pickLastSettled(DB_SETTLED) });
  const line = s.split('\n').find((l) => l.startsWith('上期('));
  assert.ok(line, '设计 §8 把「上期结算」与「三方对照」并列枚举,是两件事');
  assert.ok(line.includes('2026-07-28'));
  assert.ok(line.includes('58.0%'));
  assert.ok(line.includes('4048.6'), '「实际收多少」是可问责复盘的核心');
  assert.ok(/✓/.test(line));
});

test('T40: 样本不足时上期结算仍呈现', () => {
  // MIN_SAMPLE=20 意味着 long 要两个月才凑满 —— 若把上期复盘挂在 insufficient_sample 分支里,
  // 用户盯得最紧的头几周恰好一条反思都收不到
  const s = P.buildSummary({
    doc: DOC_FULL,
    scorecard: { by_horizon: {
      short: { n: 6, insufficient_sample: true, final: null, baseline: null, naive: null },
      medium: { n: 2, insufficient_sample: true, final: null, baseline: null, naive: null },
      long: { n: 0, insufficient_sample: true, final: null, baseline: null, naive: null },
    } },
    lastSettled: P.pickLastSettled(DB_SETTLED),
  });
  assert.ok(/短期[^\n]*样本不足/.test(s));
  const line = s.split('\n').find((l) => l.startsWith('上期('));
  assert.ok(line && line.includes('4048.6'), '聚合胜率撤下时,单条复盘绝不能跟着一起消失');
});

test('T41: 无已结算记录时明确写暂无,不整段消失', () => {
  const s = P.buildSummary({ doc: DOC_FULL, scorecard: SC_FULL,
    lastSettled: P.pickLastSettled({ predictions: [{ id: '2026-07-29', horizons: { short: { settled: false } } }] }) });
  assert.ok(s.includes('【上期结算】'));
  assert.ok(/暂无已结算记录/.test(s));
});

test('T42: 上期取最近结算的那条,不取数组末尾', () => {
  // 逾期 approx 结算会让写入顺序与结算时序不一致
  const db = { predictions: [
    { id: '2026-07-20', horizons: { short: { final: { prob_up: 0.6 }, settled: true,
      settled_date: '2026-07-30', settled_kind: 'approx', actual: 1, score: { dir_correct: false } } } },
    { id: '2026-07-28', horizons: { short: { final: { prob_up: 0.58 }, settled: true,
      settled_date: '2026-07-29', settled_kind: 'exact', actual: 2, score: { dir_correct: true } } } },
  ] };
  assert.equal(P.pickLastSettled(db).id, '2026-07-20');
  assert.equal(P.pickLastSettled(db).settled_kind, 'approx');
});

test('T43: report 模式缺 --predictions 即报参数错', () => {
  const home = freshTmp();
  const stub = seedPushInputs(home);
  const r = runScript('push.js', ['--mode', 'report', '--forecast', 'forecast.md',
    '--scorecard', 'scorecard.json'], { home, env: { OPENCLAW_BIN: stub, GOLD_FEISHU_TARGET: 'ou_x' } });
  assert.equal(r.code, 1);
  assert.ok(/predictions/.test(r.stderr), '设为可选的话漏传一次那一段就整体消失');
  fs.rmSync(home, { recursive: true, force: true });
});

test('T44: 空串 code / consecutive 不渲染空洞', () => {
  const f = P.buildFailureBrief({ step: 'validate', code: '', consecutive: '', settled: true });
  assert.ok(f.includes('退出码 未知'), 'Number("")===0 且 isFinite,会渲染出「退出码 」');
  assert.equal(/连续失败/.test(f), false);
});

test('T45: db.predictions 非数组即抛,不静默重置', () => {
  assert.throws(() => C.upsertPrediction({ schema_version: 2, predictions: { '2026-07-29': {} } },
    { id: '2026-07-29' }), /数组/, '静默重置会用一条记录覆盖掉整个权威历史库');
  assert.throws(() => C.upsertPrediction({ predictions: null }, { id: '2026-07-29' }), /数组/);
  // 未定义(全新库)仍应正常初始化
  assert.equal(C.upsertPrediction({ schema_version: 2 }, { id: '2026-07-29' }).action, 'inserted');
});

test('T46: 权威库损坏时 exit 5 且原文件一字不改', () => {
  const home = freshTmp();
  seedCommitInputs(home);
  const dbPath = path.join(home, '.local', 'state', 'gold-forecast', 'predictions.json');
  const broken = '{"schema_version":2,"predictions":{"oops":"手工编辑坏了"},"skipped_dates":[]}';
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, broken);
  const r = runScript('commit.js', ['--record', 'record.json', '--archive-dir', 'arch'], { home });
  assert.equal(r.code, 5, '退 1 会与参数错撞在一起,run.js 无从区分');
  assert.equal(fs.readFileSync(dbPath, 'utf-8'), broken, '拒绝写入,原库一字不改');
  fs.rmSync(home, { recursive: true, force: true });
});

test('T47: 落库后改 record 不回头改到权威库', () => {
  const record = { id: '2026-07-29', base_price: 4022.2, horizons: { short: { n_sessions: 1 } } };
  const r = C.upsertPrediction({ schema_version: 2, predictions: [], skipped_dates: [] }, record);
  record.base_price = 9999;
  record.horizons.short.n_sessions = 99;
  assert.equal(r.db.predictions[0].base_price, 4022.2);
  assert.equal(r.db.predictions[0].horizons.short.n_sessions, 1, '嵌套对象也不能共享引用');
});

test('T48: failure CLI 同天去重、跨天不去重', () => {
  // 日期必须真正参与哈希:只在正文里出现、却被哈希前剔掉,「连挂三天」照样只发一条
  const home = freshTmp();
  const stub = seedPushInputs(home);
  const env = { OPENCLAW_BIN: stub, GOLD_FEISHU_TARGET: 'ou_x', SEND_NOTIFY: '1' };
  const args = (d) => ['--mode', 'failure', '--step', 'validate', '--code', '5', '--settled', '1', '--date', d];
  assert.equal(runScript('push.js', args('2026-07-29'), { home, env }).code, 0);
  assert.equal(runScript('push.js', args('2026-07-29'), { home, env }).code, 0);
  assert.equal(callCount(home), 1, '同一天重跑不得重复告警');
  assert.equal(runScript('push.js', args('2026-07-30'), { home, env }).code, 0);
  assert.equal(callCount(home), 2, '换一天必须是新告警');
  fs.rmSync(home, { recursive: true, force: true });
});
