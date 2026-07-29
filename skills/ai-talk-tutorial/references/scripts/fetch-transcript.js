#!/usr/bin/env node
'use strict';
// 三级降级获取 YouTube 英文字幕,保留时间戳。
//
// 同源:移植自 VM 上 llm-video-log/subtitle.ts(生产验证)。
// ⚠️ 关键差异:原实现丢弃时间戳,本实现必须保留 —— 自检 C3 依赖它。
//    YouTube 反爬策略变化时,两处都要改。
//
// 三级:
//   1. InnerTube ANDROID client(无需 cookie)
//   2. InnerTube WEB client + cookie + SAPISIDHASH 签名
//   3. yt-dlp(必须带 --ignore-no-formats-error,2026-07-27 实测)
//
// 退出码:0=成功 1=参数错 6=全部候选取字幕失败 7=环境故障(cookie/PO token/bot 检测)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DEFAULT_COOKIES = '/home/ubuntu/.openclaw/workspace/astraeus/video素材/youtube-cookies.txt';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ---- 纯函数 ------------------------------------------------------------

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// 解析 srv3 与 classic 两种 timedtext 格式,统一产出 [{tMs, text}]
function parseTimedTextXml(xml) {
  const cues = [];

  // srv3: <p t="ms" d="ms"><s>word</s>…</p>
  const pRe = /<p\s+t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(xml)) !== null) {
    const tMs = parseInt(m[1], 10);
    const inner = m[2];
    let text = '';
    const sRe = /<s[^>]*>([^<]*)<\/s>/g;
    let s;
    while ((s = sRe.exec(inner)) !== null) text += s[1];
    if (!text) text = inner.replace(/<[^>]+>/g, '');
    text = decodeEntities(text).replace(/\s+/g, ' ').trim();
    if (text) cues.push({ tMs, text });
  }
  if (cues.length > 0) return cues;

  // classic: <text start="sec" dur="sec">content</text>
  const cRe = /<text start="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = cRe.exec(xml)) !== null) {
    const tMs = Math.round(parseFloat(m[1]) * 1000);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text) cues.push({ tMs, text });
  }
  return cues;
}

function formatTimestamp(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// 把碎 cue 合并成 minSec-maxSec 的段落。实测单视频 2793 条 cue,
// 合并后约 40-80 段,token 从数万降到约 8k。
function mergeSegments(cues, { minSec = 30, maxSec = 60 } = {}) {
  const segs = [];
  let cur = null;
  for (const c of cues) {
    const tSec = c.tMs / 1000;
    if (cur === null) {
      cur = { start: tSec, words: [c.text] };
      continue;
    }
    const span = tSec - cur.start;
    if (span >= maxSec || (span >= minSec && /[.!?]$/.test(cur.words[cur.words.length - 1]))) {
      segs.push(cur);
      cur = { start: tSec, words: [c.text] };
    } else {
      cur.words.push(c.text);
    }
  }
  if (cur) segs.push(cur);
  return segs.map((s) => ({
    start: Math.round(s.start),
    startLabel: formatTimestamp(s.start),
    text: s.words.join(' ').replace(/\s+/g, ' ').trim(),
  }));
}

// 取 stderr 末尾若干行(yt-dlp 把关键 WARNING 排在末尾,截头部会正好丢掉它们)
function tailLines(text, n) {
  const lines = String(text || '').trim().split('\n').filter(Boolean);
  return lines.slice(-n).join(' | ');
}

// yt-dlp 的 stderr 分类:环境故障 vs 这个视频本身没字幕。
//
// 2026-07-29 事故的核心:两者的 stderr **都**以
// "There are no subtitles for the requested languages" 收尾,只看这一句会把
// "整个环境取不到字幕"误判成"换一个视频就好",于是逐个候选往下滑,
// 最后把一个 2 分 12 秒的产品广告片做成了当日教程。
// 因此环境信号优先级高于无字幕信号 —— 先查环境,查不到才认内容性失败。
//
// 三类环境信号均取自当天 VM 实测原文:
//   bot 检测   "Sign in to confirm you're not a bot"(撇号是 U+2019,故用字符类兼容)
//   cookie 失效 "The provided YouTube account cookies are no longer valid"
//   PO token   "a PO token was not provided"(自动字幕整类拿不到,与具体视频无关)
const ENV_FAILURE_PATTERNS = [
  /Sign in to confirm you[’']re not a bot/i,
  /cookies are no longer valid/i,
  /PO token was not provided/i,
  /LOGIN_REQUIRED/i,
];

function classifyYtDlpFailure(stderr) {
  const s = String(stderr || '');
  if (ENV_FAILURE_PATTERNS.some((re) => re.test(s))) return 'environment';
  if (/There are no subtitles for the requested languages/i.test(s)) return 'no_subtitles';
  return 'unknown';
}

// 转录体量是否够写一篇七段教程。
//
// 绝对下限 3000 挡的是"候选本身太短":当天被选中的 WeP9VUf1OoE 只有 2052 字符
// (132 秒的产品公告),密度其实正常,单看每分钟字数完全看不出问题。
// 比例下限 200 字符/分挡的是"长视频只取到残片":实测真实演讲落在
// 523(22 分钟,有演示停顿)到 1012(41 分钟,纯口播)字符/分,200 留了足够余量,
// 不会误伤慢节奏演讲,但 55 分钟只回来 2500 字符这种残片必被拦下。
const MIN_TRANSCRIPT_CHARS = 3000;
const MIN_CHARS_PER_MINUTE = 200;

function isTranscriptSufficient(fullText, durationSec) {
  const chars = String(fullText || '').length;
  const need = Math.max(MIN_TRANSCRIPT_CHARS, (Number(durationSec) || 0) / 60 * MIN_CHARS_PER_MINUTE);
  return chars >= need;
}

// Netscape cookie 文件 → "k=v; k=v" 请求头串
function parseCookieString(raw) {
  const parts = String(raw).split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 7);
  if (parts.length === 0) return null;
  return parts.map((p) => `${p[5]}=${p[6]}`).join('; ');
}

// ---- 三级取字幕 --------------------------------------------------------

async function innertubePlayer(videoId, clientName, clientVersion, headers, extraClient = {}) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      context: { client: { clientName, clientVersion, hl: 'en', ...extraClient } },
      videoId,
    }),
  });
  if (!res.ok) throw new Error(`innertube ${clientName} HTTP ${res.status}`);
  return res.json();
}

function pickEnglishTrack(data) {
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  return tracks.find((t) => String(t.languageCode || '').startsWith('en')) || tracks[0];
}

// 级 1:ANDROID client,无 cookie
//
// clientVersion 锁定 20.10.38(与 VM 上 npm 包 youtube-transcript@1.3.1 生产验证版本一致)。
// 2026-07-27 fix round 1 实测:19.09.37 对 InnerTube player 端点直接返回 HTTP 400
// (curl 复现,payload 本身不被接受,不是我们代码逻辑的锅);20.10.38 返回 200。
// 2026-07-27 fix round 2:补全 androidSdkVersion/osName/osVersion/gl,
// 让 payload 协议上完整(不再是残缺请求体)。⚠️ 补全后仍实测 400/LOGIN_REQUIRED——
// 控制端已确认根因是 VM 缺一份有效登录态 cookie,无 cookie 时 InnerTube 各 client
// 均不可用;此级作为「YouTube 政策松动或换有效 cookie 环境时」的快路径保留。
async function tryAndroid(videoId) {
  const data = await innertubePlayer(videoId, 'ANDROID', '20.10.38', {
    'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
  }, {
    androidSdkVersion: 34,
    osName: 'Android',
    osVersion: '14',
    gl: 'US',
  });
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK' && status !== 'LIVE_STREAMING') throw new Error(`playability=${status}`);
  const track = pickEnglishTrack(data);
  if (!track) throw new Error('no caption tracks');
  const xml = await (await fetch(track.baseUrl)).text();
  return parseTimedTextXml(xml);
}

// 级 2:WEB client + cookie + SAPISIDHASH 自签名
async function tryWebWithCookies(videoId, cookiesPath) {
  if (!fs.existsSync(cookiesPath)) throw new Error(`cookie file not found: ${cookiesPath}`);
  const raw = fs.readFileSync(cookiesPath, 'utf-8');
  const cookieStr = parseCookieString(raw);
  if (!cookieStr) throw new Error('cookie file empty');

  // 防御:cookie 文件存在但既无 SAPISID 也无 __Secure-3PAPISID —— 大概率是空壳/过期文件,
  // 直接跳过,不发一次注定 LOGIN_REQUIRED 的请求。
  // 2026-07-27 fix round 2:VM 上曾出现 15 行的空壳 cookie 文件(本地 Chrome 导出版是 415
  // 行),控制端逐一实测 SAPISIDHASH/SAPISID3PHASH × 全域/仅 YT 域 × 带不带
  // X-Goog-AuthUser 全部 LOGIN_REQUIRED,连不带 Authorization 只带 cookie 也一样——
  // 根因是缺有效登录态,不是签名方式。这条防线让日后 cookie 失效时故障信息一眼可读,
  // 而不是淹没在一次必然失败的网络请求日志里。
  if (!/(?:^|\s)(?:__Secure-3PAPISID|SAPISID)\s/m.test(raw)) {
    throw new Error('cookie 文件疑似无效(缺关键字段 SAPISID/__Secure-3PAPISID)');
  }

  const apisidMatch = raw.match(/__Secure-3PAPISID\s+(\S+)/);
  if (!apisidMatch) throw new Error('__Secure-3PAPISID missing');
  const apisid = apisidMatch[1];

  const origin = 'https://www.youtube.com';
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${apisid} ${origin}`).digest('hex');

  const data = await innertubePlayer(videoId, 'WEB', '2.20240601.00.00', {
    'User-Agent': UA_WEB,
    Origin: origin,
    Referer: origin + '/',
    Cookie: cookieStr,
    Authorization: `SAPISIDHASH ${ts}_${hash}`,
  });
  const status = data?.playabilityStatus?.status;
  if (status !== 'OK' && status !== 'LIVE_STREAMING') throw new Error(`playability=${status}`);
  const track = pickEnglishTrack(data);
  if (!track) throw new Error('no caption tracks');
  const xml = await (await fetch(track.baseUrl, {
    headers: { 'User-Agent': UA_WEB, Cookie: cookieStr },
  })).text();
  return parseTimedTextXml(xml);
}

// yt-dlp 二进制解析:env YT_DLP_PATH 优先,其次探测常见安装路径,
// 都没有再回落到 PATH 里的 'yt-dlp'。
// 2026-07-27 fix round 1 实测:VM 上 'yt-dlp' 不在 PATH(ENOENT),
// 真实路径是 /home/ubuntu/.local/yt-dlp-venv/bin/yt-dlp(venv 安装,不进全局 PATH)。
function resolveYtDlpBin() {
  if (process.env.YT_DLP_PATH) return process.env.YT_DLP_PATH;
  const candidates = [
    '/home/ubuntu/.local/yt-dlp-venv/bin/yt-dlp',
    path.join(os.homedir(), '.local', 'yt-dlp-venv', 'bin', 'yt-dlp'),
    path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'yt-dlp';
}

// JS runtime 解析:yt-dlp 2026.06+ 需要它解 n-challenge,否则大量 format 与
// 自动字幕轨拿不到(实测 "n challenge solving failed" + "No supported JavaScript
// runtime could be found")。deno 默认只从 PATH 找,而 cron 的 PATH 通常不含
// ~/.deno/bin —— 显式探测并用 --js-runtimes 传绝对路径,不赌 PATH。
function resolveJsRuntimeArgs() {
  const explicit = process.env.DENO_PATH;
  const candidates = [
    explicit,
    path.join(os.homedir(), '.deno', 'bin', 'deno'),
    '/usr/local/bin/deno',
    '/opt/homebrew/bin/deno',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return ['--js-runtimes', `deno:${c}`];
  }
  return [];
}

// PO token provider 探测。2026-07-29 VM 实测三种组合:
//   无 cookie + PO token            → 仍被 bot 检测拒(IDC IP 上 PO token 替代不了登录态)
//   cookie,默认 client(android vr) → 时好时坏,且报 "Automatic captions for 1 languages are missing"
//   cookie + PO token + web client  → 此前全败的 jyuyY86GJnA/vJYXvblW4_g 都拿到字幕,en-orig/en 两轨齐全
//
// 所以 web client 只在 provider 装了的时候才切 —— 没有 provider 的 web client
// 连 player API 都过不去,会把一个能工作的默认路径换成必然失败的路径。
// provider 走 script mode(按需起进程、跑完退出):实测单次 5 秒 / 峰值 199MB,
// 而 VM 只有 1.9G 内存且 available 约 1.1G,常驻 server mode 不划算。
function resolvePotArgs() {
  const home = process.env.BGUTIL_POT_HOME
    || path.join(os.homedir(), 'bgutil-ytdlp-pot-provider', 'server');
  if (!fs.existsSync(path.join(home, 'build', 'generate_once.js'))) return [];
  return ['--extractor-args', 'youtube:player_client=web'];
}

// 级 3:yt-dlp 兜底。--ignore-no-formats-error 必需:
// 缺它则 format 选择阶段直接 "Requested format is not available" 中止,字幕不下载。
//
// ⚠️ cookie 必须传副本(2026-07-29 事故根因之一):yt-dlp 退出时会把 cookie jar
// **回写**到 --cookies 指向的文件。YouTube 轮换掉的字段就这样被覆盖进源文件,
// 实测源文件从 16 字段被啃到 13 字段(1849B → 1610B),不可逆,且每跑一次损耗一次。
// 用一次性副本后,源文件永远保持导出时的状态。
function tryYtDlp(videoId, cookiesPath) {
  const bin = resolveYtDlpBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `at-sub-${videoId}-`));
  try {
    const cookieCopy = path.join(dir, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) fs.copyFileSync(cookiesPath, cookieCopy);

    const r = spawnSync(bin, [
      '--no-update', '--socket-timeout', '30',
      ...resolveJsRuntimeArgs(),
      ...resolvePotArgs(),
      '--cookies', cookieCopy,
      '--skip-download', '--ignore-no-formats-error',
      '--write-auto-subs', '--sub-langs', 'en-orig,en', '--sub-format', 'json3',
      '-o', path.join(dir, 'sub'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { encoding: 'utf-8', timeout: 180_000 });
    if (r.error) throw new Error(r.error.message);

    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json3'));
    if (!file) {
      // yt-dlp 取不到字幕时**照样 exit 0**,所有诊断信息只存在于 stderr。
      // 旧实现只报 `no json3 produced (exit 0)`,把 bot 检测/cookie 失效/PO token
      // 三条决定性告警全丢了 —— 事故当天生产日志里一条都查不到。
      const err = new Error(
        `no json3 produced (exit ${r.status}); yt-dlp stderr: ${tailLines(r.stderr, 6)}`
      );
      err.ytDlpStderr = r.stderr || '';
      throw err;
    }
    const j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    const cues = [];
    for (const ev of j.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (text) cues.push({ tMs: ev.tStartMs, text });
    }
    return cues;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 三级全失败时,把失败**性质**一并返回 —— 调用方据此决定"换下一个候选"还是"中止"。
//
// 判定放在三级都失败之后:只要还有任何一级能取到字幕,环境就算是可用的,
// 不应该因为前两级报了 LOGIN_REQUIRED 就中止当天的流水线。
async function fetchCues(videoId, cookiesPath, tiers) {
  const all = {
    android: () => tryAndroid(videoId),
    'web+cookies': () => tryWebWithCookies(videoId, cookiesPath),
    'yt-dlp': async () => tryYtDlp(videoId, cookiesPath),
  };
  const attempts = tiers.filter((t) => all[t]).map((t) => [t, all[t]]);

  const failures = [];
  for (const [name, fn] of attempts) {
    try {
      const cues = await fn();
      if (cues && cues.length >= 10) {
        process.stderr.write(`  ✓ [${videoId}] ${name}: ${cues.length} cues\n`);
        return { cues, via: name };
      }
      const msg = `too few cues (${cues ? cues.length : 0})`;
      failures.push(msg);
      process.stderr.write(`  ⚠ [${videoId}] ${name}: ${msg}\n`);
    } catch (e) {
      failures.push(`${e.message}${e.ytDlpStderr ? '\n' + e.ytDlpStderr : ''}`);
      process.stderr.write(`  ⚠ [${videoId}] ${name}: ${e.message}\n`);
    }
  }
  return { cues: null, failure: classifyYtDlpFailure(failures.join('\n')), detail: failures.join(' ‖ ') };
}

// ---- CLI ---------------------------------------------------------------

function usage() {
  return [
    'Usage: fetch-transcript.js --candidates <path> --out <dir> [options]',
    '',
    '  --candidates <path>  discover.js 产出的 candidates.json(必填)',
    '  --out <dir>          输出目录(必填)',
    '  --cookies <path>     cookie 文件(默认 env AI_TALK_COOKIES_PATH 或内置路径)',
    '  --max-try <n>        最多尝试前 n 个候选(默认 5)',
    '  --tiers <a,b,c>      启用哪几级取字幕(默认 android,web+cookies,yt-dlp)',
    '',
    'Exit: 0=成功 1=参数错 6=全部候选失败 7=环境故障(cookie/PO token/bot 检测)',
  ].join('\n');
}

const DEFAULT_TIERS = ['android', 'web+cookies', 'yt-dlp'];

async function main() {
  const argv = process.argv.slice(2);
  const args = { candidates: null, out: null, cookies: null, maxTry: 5, tiers: DEFAULT_TIERS };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--candidates': args.candidates = argv[++i]; break;
      case '--out': args.out = argv[++i]; break;
      case '--cookies': args.cookies = argv[++i]; break;
      case '--max-try': args.maxTry = parseInt(argv[++i], 10); break;
      case '--tiers': args.tiers = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); break;
      case '-h': case '--help': process.stdout.write(usage() + '\n'); process.exit(0);
      default:
        process.stderr.write(`Unknown flag: ${argv[i]}\n${usage()}\n`);
        process.exit(1);
    }
  }
  if (!args.candidates || !args.out) {
    process.stderr.write('--candidates and --out are required\n' + usage() + '\n');
    process.exit(1);
  }
  const cookiesPath = args.cookies || process.env.AI_TALK_COOKIES_PATH || DEFAULT_COOKIES;

  // candidates.json 读取/解析单独兜底,不能落到 main().catch() 的 exit(6)——
  // 那个退出码语义是「全部候选取字幕失败」,参数写错/文件损坏属于 exit(1)(参数错)。
  // 2026-07-27 fix round 3(review F4):混淆这两者会让 cron 侧把参数错误误判成
  // 字幕层故障并发出误导性告警(SKILL.md 的 exit 6 分支会推一条飞书告警)。
  let candidates;
  try {
    const parsed = JSON.parse(fs.readFileSync(args.candidates, 'utf-8'));
    candidates = parsed.candidates;
  } catch (e) {
    process.stderr.write(`Failed to read/parse --candidates ${args.candidates}: ${e.message}\n`);
    process.exit(1);
  }
  if (!Array.isArray(candidates)) {
    process.stderr.write(`--candidates JSON 缺少 "candidates" 数组字段: ${args.candidates}\n`);
    process.exit(1);
  }

  // fix round(FR2):discover.js 零候选时仍会无条件写出 candidates.json(candidates: []),
  // 这份文件若被误传到本步(违反 SKILL.md Step 1 exit 4 分支的散文约束)会走到下面的
  // for 循环空转、直落 exit 6,触发"所有候选取字幕均失败"的告警 —— 内容是错的,
  // 会把运维引向 cookie/yt-dlp 排查这个完全无关的方向。在入口显式拦成 exit 1,
  // 与"参数/文件错误"归为一类,不再冒充"字幕层故障"。
  if (candidates.length === 0) {
    process.stderr.write(
      'candidates 为空,应走 discover.js exit 4 的零候选分支,不应到达本步'
      + `(--candidates ${args.candidates})\n`
    );
    process.exit(1);
  }

  fs.mkdirSync(args.out, { recursive: true });

  // 逐个探测,第一个有字幕的胜出 —— IDC IP 上请求越少越安全
  for (const cand of candidates.slice(0, args.maxTry)) {
    const got = await fetchCues(cand.id, cookiesPath, args.tiers);

    // 环境故障(cookie 失效/PO token 缺失/bot 检测)对每个候选都成立,
    // 继续往下试只会把流水线推向排名更低的视频 —— 2026-07-29 正是这样把一个
    // 2 分 12 秒的产品广告片顶成了当日教程。中止并让告警说清真实原因。
    if (!got.cues && got.failure === 'environment') {
      process.stderr.write(
        `FATAL: 字幕层环境故障,中止(不再尝试后续候选)。首个候选 ${cand.id}: ${got.detail}\n`
      );
      process.exit(7);
    }
    if (!got.cues) continue;

    const segments = mergeSegments(got.cues, { minSec: 30, maxSec: 60 });
    const fullText = got.cues.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();

    // 取到了但写不成教程 —— 要么候选本身太短(2 分钟公告片),要么只回来残片。
    // 算这个候选失败,换下一个,不能让残片进 Step 3。
    if (!isTranscriptSufficient(fullText, cand.durationSec)) {
      process.stderr.write(
        `  ⚠ [${cand.id}] 转录体量不足(${fullText.length} 字符 / ${cand.durationSec} 秒),跳过\n`
      );
      continue;
    }

    fs.writeFileSync(
      path.join(args.out, 'selected.json'),
      JSON.stringify({ ...cand, transcript_via: got.via }, null, 2) + '\n'
    );
    fs.writeFileSync(
      path.join(args.out, 'transcript.json'),
      JSON.stringify({
        video_id: cand.id,
        title: cand.title,
        channel: cand.channelTitle,
        duration_sec: cand.durationSec,
        via: got.via,
        cue_count: got.cues.length,
        segments,
        full_text: fullText,
      }, null, 2) + '\n'
    );
    process.stderr.write(`selected: ${cand.id} (${cand.title}) via ${got.via}, ${segments.length} segments\n`);
    process.exit(0);
  }

  process.stderr.write('FATAL: no candidate yielded a transcript\n');
  process.exit(6);
}

module.exports = {
  parseTimedTextXml, mergeSegments, parseCookieString, formatTimestamp, decodeEntities,
  resolveYtDlpBin, tryWebWithCookies, tryYtDlp,
  classifyYtDlpFailure, isTranscriptSufficient, tailLines, resolveJsRuntimeArgs, resolvePotArgs,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`FATAL: ${e.message}\n`);
    process.exit(6);
  });
}
