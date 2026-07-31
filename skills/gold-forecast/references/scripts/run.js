#!/usr/bin/env node
'use strict';
// 每日流水线编排器。顺序本身就是正确性约束(设计 3.5):结算先于入库、
// 校验先于入库、任何非零退出必须触发失败通知、修复循环的轮次由本模块持有。
//
// 本文件只做编排:各步的业务逻辑一律在各自脚本里,run.js 不重复实现任何判定。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { N_BY_HORIZON } = require('./baseline');
const { C9_PROB_THRESHOLD, C9_CENTER_FACTOR } = require('./validate');
const { parseForecast } = require('./forecast-parser');
const { buildPrompt } = require('./build-prompt');
const { DISCLAIMER_TEXT } = require('./lib/disclaimer');
const { atomicWriteText, atomicWriteJSON } = require('./lib/atomic-write');
const { promptPayload, promptScorecard } = require('./lib/prompt-payload');

const MAX_FIX_ROUNDS = 3;
// 模型阶段 120s(单次约 15s,其中 CLI 冷启动 13s);采集阶段 300s,两者分列(设计 3.6/4.5)
const BUDGET = { collect_ms: 300_000, model_ms: 120_000 };
const HORIZON_KEYS = ['short', 'medium', 'long'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PINNED_MODEL = 'minimax/MiniMax-M3';
// openclaw 不在非交互 shell 的 PATH 中(实测 ssh vm 'which openclaw' 失败),必须用绝对路径
const OPENCLAW = process.env.OPENCLAW_BIN || `${process.env.HOME}/.npm-global/bin/openclaw`;
// 只对 infra 类失败重试;oversize 与 pin_mismatch 重试一万次也是同一个结果
const MODEL_MAX_ATTEMPTS = 3;

// ---- 日期外推(缺口 3) --------------------------------------------------

function assertIsoDate(value, label) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw new Error(`run: ${label} 必须是 YYYY-MM-DD,实得 ${JSON.stringify(value)}`);
  }
}

// 从 base_date 往后数 n 个交易日,只跳周六周日。
// 不用 lib/trading-calendar.js 的 nthSession:它靠 calendar_tail 找 anchor 之后的日期,
// 而生产上 calendar_tail 全是过去的定盘日、末元素就是 base_date,filter(d > anchor) 恒空
// ⇒ 每次返回 null ⇒ 记录连 id 都构造不出来。
// 未知假日会让外推偏早,由 settle.js 的 approx 分支在结算时自我纠正(设计 5.3 pt.3)。
function addSessions(baseDate, n) {
  assertIsoDate(baseDate, 'base_date');
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`run.addSessions: n 必须是正整数,实得 ${JSON.stringify(n)}`);
  }
  // 一律走 UTC:本地时区的夏令时切换会让 +86400000 落回同一天或跳过一天
  let t = Date.parse(`${baseDate}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    t += 86400000;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return new Date(t).toISOString().slice(0, 10);
}

// ---- C9 独立复算(缺口 2) ----------------------------------------------

const centerOf = (h) => ((Number.isFinite(h && h.low) && Number.isFinite(h && h.high))
  ? (h.low + h.high) / 2 : NaN);

// 不能从 validate 的 findings 反推:checkC9 只在模型「没能给出合格理由」时才产 finding,
// 一个每天大幅偏离基线却每次都写了工整理由的模型 findings 里干干净净 ⇒ 20 天全记 false
// ⇒ scorecard 的 c9_high_rate 永远触发不了,而这恰是设计最想抓的情形。
// 故对 final vs baseline 独立复算「是否需要理由」,与 checkC9 共用同一组阈值常量。
function computeC9Triggered(finalHorizons, baselineHorizons) {
  for (const key of HORIZON_KEYS) {
    const f = finalHorizons && finalHorizons[key];
    const b = baselineHorizons && baselineHorizons[key];
    if (!f || !b) continue;
    if (Number.isFinite(f.prob_up) && Number.isFinite(b.prob_up)
      && Math.abs(f.prob_up - b.prob_up) > C9_PROB_THRESHOLD) return true;
    const fc = centerOf(f);
    const bc = centerOf(b);
    if (Number.isFinite(fc) && Number.isFinite(bc) && Number.isFinite(b.half_width)
      && Math.abs(fc - bc) > C9_CENTER_FACTOR * b.half_width) return true;
  }
  // 读取端是 `p.c9_triggered === true`,写 1 / "yes" / 计数值都会让那条触发器永久静默
  return false;
}

// ---- 进 prompt 的 payload(缺口 4) --------------------------------------

// 投影与 C4 允许池共用 lib/prompt-payload 的同一个函数 —— 两处各写一份必然漂移,
// 详见该文件顶部的不变量说明。此处保留旧名做别名,调用方无需感知。
const scorecardForPrompt = promptScorecard;

// ---- 预测记录装配(P14-1) ----------------------------------------------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// naive 恒为 p0_N(设计 5.5.2),必须取 features.p0_N ——
// 不能用 horizons.*.baseline.prob_up:该周期的 logistic 通过验收后它就不再等于 p0
// (baseline.js:`prob = coef ? predictLogistic(...) : p0`),而 naive 是无信息基准,
// 拿一个见过特征的模型输出当基准,回测增益的分母就不是「无信息」了。
function naivePOf(baseline, n) {
  const v = baseline && baseline.features && baseline.features[`p0_${n}`];
  return Number.isFinite(v) ? v : undefined;
}

const pickBand = (h) => ({ prob_up: h.prob_up, low: h.low, high: h.high });

// 把 parseForecast 输出 + baseline.json + facts.json 装配成设计 5.2 形状的记录。
// 集中在一个函数里而非散在 main() 各处:naive_p / c9_triggered / target_date 三个字段
// 此前无人认领,一次装配一次测到位才不会再漏。
function buildPredictionRecord({ doc, baseline, facts, modelId, degraded = false }) {
  if (!baseline || !baseline.horizons) throw new Error('run.buildPredictionRecord: 缺少 baseline.horizons');
  const baseDate = baseline.base_date;
  assertIsoDate(baseDate, 'baseline.base_date');

  const aiHorizons = (doc && doc.json && doc.json.horizons) || null;
  const horizons = {};
  for (const key of HORIZON_KEYS) {
    const b = baseline.horizons[key];
    if (!b) throw new Error(`run.buildPredictionRecord: baseline.horizons.${key} 缺失`);
    const n = N_BY_HORIZON[key];
    const ai = aiHorizons && aiHorizons[key];
    const h = {
      n_sessions: n,
      target_date: addSessions(baseDate, n),
      baseline: pickBand(b),
      // 降级时 final 即 baseline —— 只发基线预测,统计照常结算,不断档
      final: ai ? pickBand(ai) : pickBand(b),
      settled: false,
    };
    const naive = naivePOf(baseline, n);
    if (naive !== undefined) h.naive_p = naive;
    horizons[key] = h;
  }

  const finalHorizons = {};
  for (const key of HORIZON_KEYS) finalHorizons[key] = horizons[key].final;

  return {
    // id 就是 short 周期的 target_date(设计 5.2):upsert 的覆盖主键、buildIndex 的分年依据
    id: horizons.short.target_date,
    base_date: baseDate,
    base_price: baseline.base_price,
    base_source: `lbma:gold_pm:${baseDate}:v0`,
    // 完整性校验,防重跑不一致与意外漂移;不防刻意篡改(设计 5.2)
    facts_checksum: `sha256:${sha256(JSON.stringify(facts ?? null))}`,
    model_id: modelId || null,
    // 特征降级与编排层降级(pin 校验失败 / 修复循环耗尽)取或:两者都意味着
    // 这条 final 不是「M3 在完整特征下的判断」,都不该进 final 曲线
    degraded: Boolean(degraded) || ((baseline.degraded_features || []).length > 0),
    horizons,
    // 由 collect-facts.js 机械推导,M3 只读不写(设计 5.2 W-3)
    context_tags: (facts && facts.context_tags) || [],
    c9_triggered: computeC9Triggered(finalHorizons, baseline.horizons),
  };
}

// ---- 模型调用(设计 3.6) ------------------------------------------------

// openclaw 返回的 model 是裸名(MiniMax-M3),pin 值写全 slug(minimax/MiniMax-M3)。
// 两侧同做归一化:只对一侧处理会恒判 pin_mismatch ⇒ 每天降级成只发基线,
// 而这条降级路径本身是"正常"行为,不会有人来查为什么。
const normalizeModel = (m) => String(m == null ? '' : m).split('/').pop().trim().toLowerCase();

function interpretModelResult(r, pinnedModel) {
  const res = r || {};
  const errCode = res.error && res.error.code;

  // E2BIG:单参数超 128KB(实测 3ms 返回)。它与"进程根本没起来/被 kill"的返回值在
  // status/stdout 上完全一致 —— 都是 status=null + stdout 空,差别只在 signal/error:
  //   E2BIG    : { status: null, signal: null,      error.code: 'E2BIG' }
  //   超时 kill: { status: null, signal: 'SIGTERM', error.code: 'ETIMEDOUT' }
  //   路径配错: { status: null, signal: null,      error.code: 'ENOENT' }
  //   缺执行位: { status: null, signal: null,      error.code: 'EACCES' }
  // 原则是「环境信号优先级高于超长信号」,所以这里必须白名单 E2BIG、其余 errCode 一律
  // 归 infra ——只枚举 ETIMEDOUT 会让 ENOENT/EACCES 掉进下面那条兜底判成 oversize,
  // 于是 OPENCLAW_BIN 配错会被报成"prompt 太大",把运维引向查 prompt 体积,
  // 而 SKILL.md 自己把 openclaw 路径列为第一条排查项。
  if (errCode === 'E2BIG') return { ok: false, kind: 'oversize' };
  // 键在 error **存在**而非 error.code 有值:带 error 但无 code 的返回同样是
  // 「进程没能正常跑完」,漏判会掉进下面的 oversize 兜底。白名单只放行 E2BIG 一种。
  if (res.error || res.signal != null) {
    return { ok: false, kind: 'infra', stderr: `模型调用未能完成(signal=${res.signal ?? '-'} error=${errCode ?? '-'})` };
  }
  if (res.status === null && !res.stdout) return { ok: false, kind: 'oversize' };
  if (res.status !== 0) return { ok: false, kind: 'infra', stderr: res.stderr || `exit ${res.status}` };

  let j;
  try { j = JSON.parse(res.stdout); } catch { return { ok: false, kind: 'infra', stderr: 'stdout 非 JSON' }; }
  if (!j || !j.ok) return { ok: false, kind: 'infra', stderr: 'ok=false' };

  // 静默换模型会把别的模型的表现记进同一条 final 曲线,"M3 是否加分"的结论即废。
  // 对测量系统,"今天没有 LLM 预测"优于"今天的预测来自另一个模型"。
  if (normalizeModel(j.model) !== normalizeModel(pinnedModel) || (j.attempts && j.attempts.length > 0)) {
    return { ok: false, kind: 'pin_mismatch', model: j.model, attempts: j.attempts };
  }
  return {
    ok: true, kind: 'ok', model: j.model, attempts: j.attempts || [],
    text: (j.outputs && j.outputs[0] && j.outputs[0].text) || '',
  };
}

function callModel(promptText, { model = PINNED_MODEL, bin = OPENCLAW, spawnImpl = spawnSync } = {}) {
  // 不经 shell:prompt 含新闻标题,双引号/$/反引号/换行直传无转义风险(已实测)
  const r = spawnImpl(bin, ['infer', 'model', 'run', '--model', model, '--json', '--prompt', promptText],
    { encoding: 'utf-8', maxBuffer: 64 << 20, timeout: BUDGET.model_ms });
  return interpretModelResult(r, model);
}

// ---- 结局分类(设计 3.7) ------------------------------------------------

// pin_mismatch 刻意不在此集合内:设计 3.7 把"模型 pin 校验失败"归 degraded_success
// (照发基线预测、照结算,统计不断档),只有 API 故障/参数超长/环境异常才是 infra_failure。
const INFRA_KINDS = new Set(['oversize', 'infra']);

function classifyOutcome({ isTradingDay, settled, degraded, failedStep, failureKind } = {}) {
  // 首个分支:周末与伦敦金假日不是故障,记入 skipped_dates 会污染覆盖率
  if (!isTradingDay) return { outcome: 'non_trading_day', recordSkipped: false, push: false };
  if (failedStep) {
    // 第六种结局。缺了它,Step 4 的模型/参数故障会一律折进 failed_after_settle
    // (那时 settled 恒真),失败简报只会说"结算后失败",指不到真正的原因。
    if (INFRA_KINDS.has(failureKind)) {
      return { outcome: 'infra_failure', recordSkipped: true, push: true, signature: failureKind };
    }
    return settled
      ? { outcome: 'failed_after_settle', recordSkipped: true, push: true }
      : { outcome: 'failed_before_settle', recordSkipped: true, push: true };
  }
  return degraded
    ? { outcome: 'degraded_success', recordSkipped: false, push: true }
    : { outcome: 'success', recordSkipped: false, push: true };
}

// 失败简报里给人看的签名文案。运维拿到的是这几个字,不是 kind 的英文枚举。
const FAILURE_SIGNATURE_LABEL = {
  oversize: '参数超长(单参数超出内核 128KB 上限)',
  infra: '模型 API 或运行环境异常(先查 openclaw 路径与网关)',
};

// 两种 oversize 的处置口径不同,文案必须分开:内核 128KB 是运行时撞上的,
// build-prompt 的 100KB 是自己先 fail-fast 的。写混了运维会照 128KB 去量,
// 发现 prompt 才 101KB,转而怀疑消息本身。
const OVERSIZE_NOTE_BUILD_PROMPT = '参数超长(超出 build-prompt 的 100KB 预算,错误信息里附各块字节数)';

// run.js 自身的退出码。3 单独留给"入库归档已成功但备份失败"(commit.js 透传),
// 与 6/7 分开 —— 那不是流水线失败,不该让 cron 的重试逻辑当成需要重跑。
const EXIT_BY_OUTCOME = {
  non_trading_day: 0, success: 0, degraded_success: 0,
  failed_before_settle: 6, failed_after_settle: 6, infra_failure: 7,
};

// 目标日由最新可得定盘日推导,不用 new Date():时钟漂移或 cron 异常触发
// 不应导致写入错误日期的预测(设计 3.7 E-7)。
function resolveToday({ latestSession } = {}) {
  assertIsoDate(latestSession, 'latestSession');
  return latestSession;
}

// 删除属编排职责(设计 3.5):校验器删产物会让第 2 轮无从改起。
const shouldDeleteArtifacts = ({ round, passed }) => !passed && round >= MAX_FIX_ROUNDS;

// ---- 子步骤调用 ---------------------------------------------------------

const SCRIPTS = {
  'collect-settlement': 'collect-settlement.js',
  settle: 'settle.js',
  scorecard: 'scorecard.js',
  'collect-facts': 'collect-facts.js',
  baseline: 'baseline.js',
  validate: 'validate.js',
  render: 'render.js',
  commit: 'commit.js',
  push: 'push.js',
};

// 各子脚本一律以子进程跑:它们的退出码分层(1=参数错 / 3=备份失败 / 4=发送失败 /
// 5=运行期异常)是本编排器的判据,require 进来直接调会把这层信息全丢掉。
function runScript(name, args, { timeoutMs = BUDGET.collect_ms, spawnImpl = spawnSync, env = process.env } = {}) {
  const file = SCRIPTS[name];
  if (!file) throw new Error(`run.runScript: 未知步骤 ${name}`);
  const r = spawnImpl(process.execPath, [path.join(__dirname, file), ...args],
    { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 32 << 20, env }) || {};
  // 超时被 kill 时 status 为 null,`code !== 0` 判不出来 —— 归一成非零的 124(SIGTERM 约定)
  const timedOut = r.status === null || r.status === undefined;
  return {
    code: timedOut ? 124 : r.status,
    stdout: r.stdout || '', stderr: r.stderr || '', timedOut,
  };
}

// 只对 infra 类重试:oversize 是 prompt 太大、pin_mismatch 是换了模型,重试一万次同结果,
// 每轮还要白付 13 秒 CLI 冷启动。
function callModelWithRetry(promptText, { callModelImpl = callModel, attempts = MODEL_MAX_ATTEMPTS, onAttempt } = {}) {
  let last = { ok: false, kind: 'infra', stderr: '未调用' };
  for (let i = 1; i <= attempts; i++) {
    last = callModelImpl(promptText, {});
    if (onAttempt) onAttempt(i, last);
    if (last.kind !== 'infra') return { ...last, tries: i };
  }
  return { ...last, tries: attempts };
}

// ---- 非交易日判定(不需要系统时钟,也不需要交易日历外推) -----------------

// 比对最新定盘日与已提交预测里最大的 base_date:不比它新就是没有新定盘 ⇒ 跳过当日。
// 零时钟、零日历外推,直接复用已有产物。「目标日不用 new Date()」约束的是写进记录的
// 日期字段(防漂移),不是禁止判断该不该跑。
function hasNewSession({ latestSession, db }) {
  assertIsoDate(latestSession, 'latestSession');
  const preds = (db && Array.isArray(db.predictions)) ? db.predictions : [];
  let maxBase = '';
  for (const p of preds) {
    if (p && typeof p.base_date === 'string' && p.base_date > maxBase) maxBase = p.base_date;
  }
  if (!maxBase) return true;   // 首次运行:库里还没有任何预测,照跑
  return latestSession > maxBase;
}

// ---- 中间产物路径(物理断路:partial 绝不落正式路径) --------------------

// 全部落 stateDir/work/,只有 commit.js 才把通过自检的那份搬进归档目录。
// 带 round 编号是为了让第 2/3 轮能同时看到上一轮的原文与 findings。
function workPaths(workDir) {
  const at = (n) => path.join(workDir, n);
  return {
    dir: workDir,
    prompt: (r) => at(`prompt-r${r}.txt`),
    forecast: (r) => at(`forecast-r${r}.md`),
    findings: (r) => at(`findings-r${r}.json`),
    degradedForecast: at('forecast-degraded.md'),
    reportHtml: at('report.html'),
    reportMd: at('report.md'),
    record: at('record.json'),
    newLessons: at('new-lessons.json'),
  };
}

// 最终放弃时删哪些:逐轮的 prompt / forecast / findings,加上可能已渲染的报告与记录。
// 清单显式列出而非通配删除 —— work/ 里若混进别的东西,通配会一起抹掉。
function artifactsToDelete({ workDir, rounds = MAX_FIX_ROUNDS }) {
  const p = workPaths(workDir);
  const out = [];
  for (let r = 1; r <= rounds; r++) out.push(p.prompt(r), p.forecast(r), p.findings(r));
  out.push(p.reportHtml, p.reportMd, p.record);
  return out;
}

// ---- 降级产物(只发基线预测) -------------------------------------------

const HORIZON_LABEL = { short: '短期', medium: '中期', long: '长期' };

// 七段必须齐全:forecast-parser 用「下一个中文序号」当右边界,少了「## 二、」
// 第一段就整段解析不出来(实测),下游 render 与记录装配一起拿到空 doc。
const DEGRADED_SECTIONS = [
  ['二', '市场事实', '本期为降级预测,不呈现事实快照;原始数据见同期归档的 facts 与 baseline 产物。'],
  ['三', '对手盘结构', '本期为降级预测,不呈现对手盘拆解。'],
  ['四', '判断依据', '本期无模型判断,区间与概率由量化基线直接给出,依据即基线本身的统计口径。'],
  ['五', '上期结算与反思', '本期为降级预测,不作反思;三方对照见本段下方自动插入的记分卡表格。'],
  ['六', '如何使用本区间', '区间为八成把握的价格范围,由日波动率按周期开方外推得到;'
    + '如何据此设定自己的风险距离由你自行决定,本报告不给具体数值。'],
];

// 降级时没有模型输出,但报告与记录照发照结算(设计 3.6:少一个样本优于掺沙子)。
// 正文里每个数字都直接取自 baseline.json,没有任何外推或改写。
function buildDegradedForecast({ baseline, reason }) {
  const horizons = {};
  for (const key of HORIZON_KEYS) {
    const b = baseline.horizons[key];
    horizons[key] = { prob_up: b.prob_up, direction: b.prob_up > 0.5 ? 'up' : 'down', low: b.low, high: b.high };
  }
  return [
    '```json', JSON.stringify({ horizons }, null, 1), '```', '',
    '## 一、今日结论', '',
    `本期为降级预测(${reason})。以下三期概率与区间全部直接来自量化基线,未经模型调整。`,
    '本期标记 degraded,不计入模型表现统计,但照常结算,历史统计不断档。', '',
    ...HORIZON_KEYS.map((k) => `- ${HORIZON_LABEL[k]}(T+${N_BY_HORIZON[k]}) 上涨概率 ${horizons[k].prob_up},`
      + `区间 ${horizons[k].low} – ${horizons[k].high}`),
    '', `基准交易日 ${baseline.base_date},基准价 ${baseline.base_price}。`, '',
    ...DEGRADED_SECTIONS.flatMap(([num, title, body]) => [`## ${num}、${title}`, '', body, '']),
    '## 七、免责声明', '', DISCLAIMER_TEXT, '',
  ].join('\n');
}

// ---- 运行状态(连续失败天数) -------------------------------------------

const FAILED_OUTCOMES = new Set(['failed_before_settle', 'failed_after_settle', 'infra_failure']);

// LBMA 源冻结(持续返回 HTTP 200 + 旧 JSON)会让系统每天判 non_trading_day、
// 零推送、零告警、无限期静默。真实假期最长连跑 4 次(复活节:周五假 + 周末 + 周一假,
// 圣诞同量级),故 6 次是「日历解释不了」的下界,不会被正常假期误触发。
const STALE_SESSION_ALERT_RUNS = 6;

const readJsonOr = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
};

const isTruthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ''));

// 连续计数是「偶发还是坏了」的唯一线索,故必须跨运行持久化。
// 两个计数分开:非交易日不是失败(混进失败计数会把周末算成故障),
// 但连续太多次非交易日本身也是一种故障(源冻结),故单独计一份。
function bumpRunState(statePath, outcome) {
  const prev = readJsonOr(statePath, {}) || {};
  const prevF = Number.isFinite(prev.consecutive_failures) ? prev.consecutive_failures : 0;
  const prevN = Number.isFinite(prev.consecutive_non_trading) ? prev.consecutive_non_trading : 0;
  const next = {
    last_outcome: outcome,
    consecutive_failures: FAILED_OUTCOMES.has(outcome) ? prevF + 1 : 0,
    consecutive_non_trading: outcome === 'non_trading_day' ? prevN + 1 : 0,
  };
  atomicWriteJSON(statePath, next, { keepVersions: 0 });
  return next;
}

// 「首次部署」与「权威库不见了」必须分开:前者要新建空库,后者一旦新建就会
// settle 在空库上跑 → scorecard 全 insufficient → commit 只入一条 → rsync 把备份也
// 换成单条版本,全程 exit 0 无告警,整部历史静默归零。
// 判据:run-state.json 每次运行都写,versions/ 是原子写滚动的旧版 —— 两者任一存在
// 都说明这台机器跑过,那 predictions.json 就是「不见了」而不是「还没有」。
function predictionsDbState({ predictions, runState }) {
  if (fs.existsSync(predictions)) return 'present';
  const versionsDir = path.join(path.dirname(predictions), 'versions');
  const hadVersions = fs.existsSync(versionsDir)
    && fs.readdirSync(versionsDir).some((f) => f.startsWith(`${path.basename(predictions)}.`));
  return (fs.existsSync(runState) || hadVersions) ? 'missing' : 'fresh';
}

// 跳过的日期记入 skipped_dates 并在 scorecard 报告覆盖率;去重后排序,重跑幂等。
function recordSkippedDate(dbPath, date) {
  const db = readJsonOr(dbPath, null);
  // 库读不出来时绝不新建:那可能是权威库损坏,一次写入就把整部历史覆盖成一条空记录
  if (!db || !Array.isArray(db.predictions)) return false;
  const set = new Set(Array.isArray(db.skipped_dates) ? db.skipped_dates : []);
  if (set.has(date)) return false;
  set.add(date);
  db.skipped_dates = [...set].sort();
  atomicWriteJSON(dbPath, db);
  return true;
}

// ---- dry-run 沙箱 -------------------------------------------------------

// 演练的价值恰恰在于「查当天的数据对不对」——当天定盘价是错的或陈旧的,正是它要抓的。
// 所以不能跳过 settle。但 settle 是**一次性**的(`settle.js` 的 `if (h.settled) return false`):
// 在真库上演练一次,所有到期 horizon 就被永久写上基于错价的分数,之后真实运行被
// h.settled 短路跳过,错分永久留在度量库里,全程 exit 0。
// 故把权威库与 history 复制一份,所有**会写**它们的步骤都指向副本:演练照跑、真库不动。
// 只读输入(lessons.json / params.json)仍指向真文件。
function withDryRunSandbox(P, { log } = {}) {
  const dir = path.join(P.work.dir, 'dry-run-sandbox');
  fs.rmSync(dir, { recursive: true, force: true });   // 每次从干净副本开始,重复演练可复现
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(P.predictions)) fs.copyFileSync(P.predictions, path.join(dir, 'predictions.json'));
  if (fs.existsSync(P.history)) fs.cpSync(P.history, path.join(dir, 'history'), { recursive: true });
  if (log) log(`dry-run:权威库与 history 已复制到 ${dir},本次全部写入都落在副本上`);
  const at = (n) => path.join(dir, n);
  return {
    ...P,
    sandboxDir: dir,
    predictions: at('predictions.json'),
    history: at('history'),
    settlement: at('settlement-price.json'),
    facts: at('facts.json'),
    baseline: at('baseline.json'),
    scorecard: at('scorecard.json'),
    runState: at('run-state.json'),
  };
}

// ---- 流水线 ------------------------------------------------------------

const EMPTY_DB = { schema_version: 2, predictions: [], skipped_dates: [] };

function resolvePaths({ stateDir, archiveDir }) {
  const s = (n) => path.join(stateDir, n);
  return {
    stateDir,
    archiveDir,
    history: s('history'),
    predictions: s('predictions.json'),
    settlement: s('settlement-price.json'),
    facts: s('facts.json'),
    baseline: s('baseline.json'),
    scorecard: s('scorecard.json'),
    lessons: s('lessons.json'),
    params: s('params.json'),
    runState: s('run-state.json'),
    work: workPaths(s('work')),
  };
}

// 顺序即不变量(设计 3.5):Step 1a → 2 → 2b 只依赖 LBMA,其余源全挂也照常完成;
// 校验先于入库;任何非零退出都触发失败通知。
function runPipeline({
  stateDir, archiveDir, today: todayArg = null, dryRun = false, urlBase = null,
  runScriptImpl = runScript, callModelImpl = callModel, env = process.env,
  log = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  const P0 = resolvePaths({ stateDir, archiveDir });
  const trace = [];
  const st = { settled: false, degraded: false, degradeReason: null, modelId: null,
               rounds: 0, backupFailed: false, pushFailed: false, predictionId: null, detail: null };

  fs.mkdirSync(P0.work.dir, { recursive: true });
  // dry-run 的全部写入改指向副本;真库与 history 一个字节都不动
  const P = dryRun ? withDryRunSandbox(P0, { log }) : P0;

  // push.js 未设 SEND_NOTIFY 时走 --dry-run 且**退 0**,于是链路全绿、报告永不到达、
  // 失败简报同样永不到达 —— 整条通知层静默关闭而退出码是 0。不 fail(演练场景合法),
  // 但必须显著告警,否则运维会以为发出去了。
  st.notifyDisabled = !dryRun && !isTruthy(env.SEND_NOTIFY);
  if (st.notifyDisabled) {
    log('WARN: SEND_NOTIFY 未设为 1 —— push.js 将只演练不真发,报告与失败简报都不会到达任何人,'
      + '而退出码仍是 0。cron 环境请显式导出 SEND_NOTIFY=1。');
  }

  const step = (name, args, timeoutMs = BUDGET.collect_ms) => {
    const r = runScriptImpl(name, args, { timeoutMs });
    trace.push({ step: name, code: r.code, timedOut: Boolean(r.timedOut) });
    // 退 0 的 WARN 也得出声:教训库限流与拒收只走 stderr,吞掉就是静默卡死
    for (const line of (r.stderr || '').split('\n')) {
      if (line.startsWith('WARN:')) log(`${name}: ${line}`);
    }
    if (r.code !== 0) log(`步骤 ${name} 退出码 ${r.code}${r.timedOut ? '(超时)' : ''}: ${(r.stderr || '').slice(-400)}`);
    return r;
  };

  // skipped_dates 必须与 prediction.id 同一套口径(都是 short 的 target_date),
  // 否则覆盖率会把 base_date 与 target_date 两种日期混进同一个分母,
  // 而 Set 去重还会把「D 日晚失败」和「D+1 日早失败」并成一天。
  const skipDateFor = () => {
    if (st.predictionId) return st.predictionId;
    const base = todayArg || st.latestSession;
    return base ? addSessions(base, N_BY_HORIZON.short) : null;
  };

  const finish = ({ failedStep = null, failureKind = null, isTradingDay = true, exitOverride = null }) => {
    const cls = classifyOutcome({ isTradingDay, settled: st.settled, degraded: st.degraded, failedStep, failureKind });
    // dry-run 一个字节都不写权威库:部署清单第 5 步就是先演练一次,那时 key 多半还没配好,
    // 第一次演练就往 predictions.json 记跳过日、还起一条失败连击,是最坏的首因印象。
    // 裁定 2 授权的是「1a/1b 对 history/ 的 upsert 照常」,不含写 predictions.json。
    if (dryRun) {
      log(`dry-run:不写 skipped_dates、不累计连续失败(结局 ${cls.outcome})`);
    } else if (cls.recordSkipped) {
      const d = skipDateFor();
      if (d) recordSkippedDate(P.predictions, d);
      else log('WARN: Step 1a 就挂了,连目标日都无从确定,本次不记 skipped_dates —— 记一个编造的日期比不记更糟');
    }
    const runState = dryRun ? (readJsonOr(P.runState, {}) || {}) : bumpRunState(P.runState, cls.outcome);
    // 源冻结的兜底:连续太多次「无新定盘」不可能由日历解释
    const staleRuns = runState.consecutive_non_trading || 0;
    if (cls.outcome === 'non_trading_day' && staleRuns >= STALE_SESSION_ALERT_RUNS && !dryRun) {
      log(`WARN: 已连续 ${staleRuns} 次判为无新定盘,LBMA 源可能已冻结(持续返回旧数据)`);
      runScriptImpl('push', ['--mode', 'failure', '--step', `stale-lbma · 连续 ${staleRuns} 次无新定盘`,
        '--settled', '0', '--state-dir', stateDir, '--consecutive', String(staleRuns)],
      { timeoutMs: BUDGET.collect_ms });
    }
    if (failedStep && cls.push && !dryRun) {
      // 签名必须进到人手上的那条消息里。push.js 没有 --signature 形参(加形参属 Task 14
      // 的接口),故并进 --step —— 简报正文是「失败步骤 X · 退出码 N」,这样 X 自带原因。
      const label = (st.detail && st.detail.signatureNote) || FAILURE_SIGNATURE_LABEL[cls.signature];
      const brief = ['--mode', 'failure', '--step', label ? `${failedStep} · ${label}` : failedStep,
        '--settled', st.settled ? '1' : '0', '--state-dir', stateDir,
        '--consecutive', String(runState.consecutive_failures ?? 1)];
      // 只有真有子进程退出码时才传:模型故障没有子进程,合成一个数字会和 push.js
      // 自己的码表(1=参数错 4=发送失败)撞车,同一个数字两处含义不同。缺省显示「未知」。
      if (Number.isFinite(st.detail?.code)) brief.push('--code', String(st.detail.code));
      if (st.latestSession) brief.push('--date', st.latestSession);
      const pr = runScriptImpl('push', brief, { timeoutMs: BUDGET.collect_ms });
      if (pr.code !== 0) log(`FATAL: 失败简报也没发出去(push exit ${pr.code}) —— 告警通道本身出问题了`);
    }
    let exitCode = exitOverride ?? EXIT_BY_OUTCOME[cls.outcome];
    // 备份失败与推送失败都不推翻「预测已入库」这个事实,但退出码要刺眼
    if (exitCode === 0 && st.backupFailed) exitCode = 3;
    if (exitCode === 0 && st.pushFailed) exitCode = 4;
    log(`结局 ${cls.outcome},退出码 ${exitCode}`);
    return { ...cls, exitCode, trace, degraded: st.degraded, rounds: st.rounds,
             notifyDisabled: Boolean(st.notifyDisabled), staleRuns,
             predictionId: st.predictionId, backupFailed: st.backupFailed, pushFailed: st.pushFailed,
             failedStep, failureKind };
  };

  // —— Step 1a:只依赖 LBMA ——
  let r = step('collect-settlement', ['--history', P.history, '--out', P.settlement], BUDGET.collect_ms);
  if (r.code !== 0) { st.detail = { code: r.code }; return finish({ failedStep: 'collect-settlement' }); }

  const settlement = readJsonOr(P.settlement);
  const latestSession = settlement && settlement.latest && settlement.latest.date;
  st.latestSession = latestSession;

  // 判的是**真库**的状态而不是副本的:否则 dry-run 在一台丢了库的机器上会看成 fresh
  const dbState = predictionsDbState(P0);
  if (dbState === 'missing') {
    log('FATAL: predictions.json 不存在,但本机跑过(run-state.json 或 versions/ 仍在)——'
      + '判为权威库丢失,拒绝新建空库。从 ~/backup/gold-forecast/ 恢复,'
      + '或从 versions/ 捞回上一版;确属首次部署请手工创建一个空库再跑。');
    st.detail = { code: 5 };
    return finish({ failedStep: 'predictions-db', exitOverride: 5 });
  }
  if (dbState === 'fresh') {
    // dry-run 时 P.predictions 是副本路径 —— 演练不该在干净机器上创建权威库
    log(dryRun ? '首次部署演练:在副本里建空 predictions.json' : '首次部署:新建空 predictions.json');
    atomicWriteJSON(P.predictions, EMPTY_DB);
  }
  const db = readJsonOr(P.predictions);

  // 显式传 --today 即人工补跑/重跑意图,跳过本闸门(upsert 幂等);
  // 无 --today 的日常运行则由本闸门兜住陈旧价格与重复运行。
  if (!todayArg && !hasNewSession({ latestSession, db })) {
    log(`最新定盘日 ${latestSession} 不比已有预测的基准日更新,判为非交易日/无新定盘,跳过`);
    return finish({ isTradingDay: false });
  }
  const today = todayArg || resolveToday({ latestSession });

  // —— Step 2:结算先于一切写入 ——
  r = step('settle', ['--predictions', P.predictions, '--settlement', P.settlement, '--today', today]);
  if (r.code !== 0) { st.detail = { code: r.code }; return finish({ failedStep: 'settle' }); }
  st.settled = true;

  // —— Step 2b:纯函数投影 ——
  r = step('scorecard', ['--predictions', P.predictions, '--lessons', P.lessons, '--out', P.scorecard]);
  if (r.code !== 0) { st.detail = { code: r.code }; return finish({ failedStep: 'scorecard' }); }

  // —— Step 1b:其余 7 源;失败不影响上面三步已落盘的结果 ——
  r = step('collect-facts', ['--out', P.facts, '--history', P.history, '--today', today], BUDGET.collect_ms);
  if (r.code !== 0) { st.detail = { code: r.code }; return finish({ failedStep: 'collect-facts' }); }

  // —— Step 3:只读 history/,与回测走同一条数据路径 ——
  r = step('baseline', ['--history', P.history, '--as-of', today, '--params', P.params, '--out', P.baseline]);
  if (r.code !== 0) { st.detail = { code: r.code }; return finish({ failedStep: 'baseline' }); }

  const facts = readJsonOr(P.facts);
  const baseline = readJsonOr(P.baseline);
  const scorecard = readJsonOr(P.scorecard);
  if (!baseline || !baseline.horizons) { st.detail = { code: 5 }; return finish({ failedStep: 'baseline' }); }
  const lessons = (readJsonOr(P.lessons, {}) || {}).lessons || [];
  // 本该产出的 id 一旦可推导就先记下:skipped_dates 必须与 prediction.id 同一套日期口径,
  // 否则 scorecard 的覆盖率会把 base_date 和 target_date 两种日期混在一个分母里。
  st.predictionId = addSessions(baseline.base_date, N_BY_HORIZON.short);

  const degrade = (reason) => { st.degraded = true; st.degradeReason = reason; log(`降级:${reason}`); };

  // —— Step 4 + 5:模型撰写与自检,3 轮修复循环 ——
  let prior = null;
  let passed = false;
  for (let round = 1; round <= MAX_FIX_ROUNDS; round++) {
    st.rounds = round;
    let prompt;
    try {
      prompt = buildPrompt({
        ...promptPayload({ facts, baseline, scorecard }), lessons,
        contextTags: (facts && facts.context_tags) || [],
        news: (facts && facts.news && facts.news.items) || [],
        priorFindings: prior,
      });
    } catch (e) {
      // build-prompt 的 100KB fail-fast:是参数超长而非模型故障,不进重试
      log(`build-prompt 超限:${e.message}`);
      // 不合成退出码:这里根本没有子进程,编一个 1 会和 push.js 码表的「1=参数错」撞车
      st.detail = { code: null, signatureNote: OVERSIZE_NOTE_BUILD_PROMPT };
      return finish({ failedStep: 'build-prompt', failureKind: 'oversize' });
    }
    atomicWriteText(P.work.prompt(round), prompt.text, { keepVersions: 0 });

    const m = callModelWithRetry(prompt.text, { callModelImpl });
    if (m.kind === 'oversize' || m.kind === 'infra') {
      // 不合成退出码:模型调用没有子进程退出码,编一个会和 push.js 的码表撞车
      st.detail = { code: null };
      log(`模型调用失败(${m.kind},试 ${m.tries} 次):${m.stderr || ''}`);
      return finish({ failedStep: 'model', failureKind: m.kind });
    }
    if (m.kind === 'pin_mismatch') { degrade(`模型 pin 校验失败(实得 ${m.model ?? '未知'})`); break; }

    st.modelId = m.model;
    atomicWriteText(P.work.forecast(round), m.text, { keepVersions: 0 });

    // validate 只出 findings、不删产物;通过与否由本编排器读 findings.passed 判定
    const vArgs = ['--forecast', P.work.forecast(round), '--facts', P.facts, '--baseline', P.baseline,
      '--scorecard', P.scorecard, '--predictions', P.predictions, '--out', P.work.findings(round)];
    // 上一轮 findings 进了本轮 prompt ⇒ 必须同时进 C4 允许池,否则模型复述阈值就被拦
    if (round > 1) vArgs.push('--prior-findings', P.work.findings(round - 1));
    r = step('validate', vArgs);
    if (r.code !== 0) { st.detail = { code: r.code }; return finish({ failedStep: 'validate' }); }
    const fnd = readJsonOr(P.work.findings(round), { passed: false, findings: [] });
    if (fnd.passed) { passed = true; break; }
    log(`第 ${round} 轮自检未通过,${fnd.findings.length} 条 findings`);
    // 第 2/3 轮把 findings 连同上一轮原文喂回;只重跑 Step 4→5,不重跑采集与结算 ——
    // findings 引用的是同一批 facts/baseline/scorecard,不会因模型改写文本而变
    prior = { round, findings: fnd.findings, forecast: m.text };
  }

  if (shouldDeleteArtifacts({ round: st.rounds, passed })) {
    for (const f of artifactsToDelete({ workDir: P.work.dir, rounds: st.rounds })) fs.rmSync(f, { force: true });
    degrade(`自检 ${MAX_FIX_ROUNDS} 轮未通过`);
  }

  let forecastPath;
  if (st.degraded && !passed) {
    forecastPath = P.work.degradedForecast;
    atomicWriteText(forecastPath, buildDegradedForecast({ baseline, reason: st.degradeReason }), { keepVersions: 0 });
  } else {
    forecastPath = P.work.forecast(st.rounds);
  }
  const doc = parseForecast(fs.readFileSync(forecastPath, 'utf-8'));

  // —— Step 5 后半:渲染 ——
  r = step('render', ['--forecast', forecastPath, '--scorecard', P.scorecard, '--baseline', P.baseline,
    '--settlement', P.settlement, '--out-html', P.work.reportHtml, '--out-md', P.work.reportMd]);
  if (r.code !== 0) { st.detail = { code: r.code }; return finish({ failedStep: 'render' }); }

  const record = buildPredictionRecord({ doc, baseline, facts, modelId: st.modelId, degraded: st.degraded });
  st.predictionId = record.id;
  atomicWriteJSON(P.work.record, record, { keepVersions: 0 });

  // 降级时 doc 来自 buildDegradedForecast(没有 new_lessons 字段),这里自然落空数组
  const newLessons = (doc && doc.json && Array.isArray(doc.json.new_lessons)) ? doc.json.new_lessons : [];
  atomicWriteJSON(P.work.newLessons, newLessons, { keepVersions: 0 });

  // dry-run 只跳 Step 6/7;1a/1b 对 history/ 的 upsert 与结算照常(幂等)
  if (dryRun) {
    log(`dry-run:已产出 ${record.id} 的记录与报告,跳过入库与推送`);
    return finish({});
  }

  // —— Step 6:入库 + 归档 ——
  r = step('commit', ['--record', P.work.record, '--archive-dir', P.archiveDir, '--predictions', P.predictions,
    '--state-dir', stateDir, '--report-html', P.work.reportHtml, '--report-md', P.work.reportMd,
    '--scorecard', P.scorecard,
    '--new-lessons', P.work.newLessons, '--lessons', P.lessons]);
  if (r.code === 3) {
    // 备份失败:入库与归档已成功,重跑本命令幂等。算成功 —— 判成失败会为了修一个
    // rsync 问题去重跑整条流水线(含再付一次模型费用),而预测本身完好无损。
    // 但退出码透传 3,cron 日志里仍然刺眼。
    st.backupFailed = true;
    log('WARN: 入库与归档已完成,唯一恢复源(备份)失败 —— 修好后重跑 commit.js 即可');
  } else if (r.code !== 0) {
    // 5=运行期异常/权威库损坏,1=参数错;都不重试,但简报要能区分
    st.detail = { code: r.code };
    return finish({ failedStep: 'commit' });
  }

  // —— Step 7:飞书摘要 ——
  const pushArgs = ['--mode', 'report', '--forecast', forecastPath, '--scorecard', P.scorecard,
    '--predictions', P.predictions, '--date', record.id, '--state-dir', stateDir];
  if (urlBase) pushArgs.push('--url', `${String(urlBase).replace(/\/+$/, '')}/${record.id}.html`);
  r = step('push', pushArgs);
  if (r.code !== 0) {
    // 预测已入库、结算正常,只是通知没发出去。不再补发失败简报 ——
    // 同一条通道刚失败,失败简报会以完全相同的方式失败。
    st.pushFailed = true;
    log(`FATAL: 飞书摘要未发出(push exit ${r.code}),预测已入库,人工核对后可重跑 push.js`);
  }
  return finish({});
}

// ---- CLI ---------------------------------------------------------------

const FLAGS = ['today', 'state-dir', 'archive-dir', 'url-base'];
const BOOLS = ['dry-run'];

function usage() {
  return [
    'Usage: run.js [--today YYYY-MM-DD] [--dry-run]',
    '              [--state-dir <dir>] [--archive-dir <dir>] [--url-base <url>]',
    '',
    '--dry-run  跳过 Step 6 入库与 Step 7 推送;采集、结算、记分卡、渲染照常执行',
    '--today    人工补跑/重跑用;显式给出即跳过「无新定盘则跳过」闸门(upsert 幂等)',
    '',
    '环境变量: GOLD_ARCHIVE_DIR GOLD_FEISHU_TARGET GOLD_FEISHU_ACCOUNT',
    '          GOLD_REPORT_URL_BASE FRED_API_KEY OPENCLAW_BIN SEND_NOTIFY',
    '',
    'Exit: 0=success/degraded_success/non_trading_day  3=已入库但备份失败',
    '      4=已入库但推送失败  5=运行期异常  6=流水线失败  7=基础设施失败',
  ].join('\n');
}

function die(msg) {
  process.stderr.write(`${msg}\n${usage()}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-h' || argv[i] === '--help') { process.stdout.write(`${usage()}\n`); process.exit(0); }
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || (!FLAGS.includes(key) && !BOOLS.includes(key))) die(`未知参数: ${argv[i]}`);
    if (BOOLS.includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // 参数错必须退 1:让 assertIsoDate 的异常冒到外层 catch 就退成 5,而 5 的语义是
  // 「运行期异常/权威库损坏」—— 恰好是本文件竭力要和参数错区分开的那一类
  if (args.today && !ISO_DATE_RE.test(args.today)) die(`--today 必须是 YYYY-MM-DD,实得 ${args.today}`);
  const home = process.env.HOME || '';
  const stateDir = path.resolve(args['state-dir'] || path.join(home, '.local', 'state', 'gold-forecast'));
  const archiveDir = args['archive-dir'] || process.env.GOLD_ARCHIVE_DIR;
  const dryRun = Boolean(args['dry-run']);
  if (!archiveDir && !dryRun) die('缺少参数 --archive-dir(或环境变量 GOLD_ARCHIVE_DIR)');
  // 推送收件人在最后一步才用,但缺了它 Step 7 必挂 —— 前置检查,别让整条流水线
  // 跑完(含模型费用)才发现配错了
  if (!dryRun && !process.env.GOLD_FEISHU_TARGET) die('缺少环境变量 GOLD_FEISHU_TARGET');

  const res = runPipeline({
    stateDir,
    archiveDir: archiveDir ? path.resolve(archiveDir) : null,
    today: args.today || null,
    dryRun,
    urlBase: args['url-base'] || process.env.GOLD_REPORT_URL_BASE || null,
  });
  process.exit(res.exitCode);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // 运行期异常单独退 5:退 1 会和「参数错」撞在一起
    process.stderr.write(`FATAL: 运行期异常: ${(e && e.stack) || e}\n`);
    process.exit(5);
  }
}

module.exports = {
  MAX_FIX_ROUNDS, BUDGET, HORIZON_KEYS, PINNED_MODEL, MODEL_MAX_ATTEMPTS, EXIT_BY_OUTCOME, SCRIPTS,
  addSessions, computeC9Triggered, scorecardForPrompt, promptPayload, naivePOf, buildPredictionRecord,
  normalizeModel, interpretModelResult, callModel, classifyOutcome, resolveToday,
  shouldDeleteArtifacts, runScript, callModelWithRetry, hasNewSession, workPaths, artifactsToDelete,
  predictionsDbState, STALE_SESSION_ALERT_RUNS, withDryRunSandbox,
  buildDegradedForecast, bumpRunState, recordSkippedDate, resolvePaths, runPipeline,
};
