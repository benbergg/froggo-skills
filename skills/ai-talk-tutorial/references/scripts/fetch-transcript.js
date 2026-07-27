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
// 退出码:0=成功 1=参数错 6=全部候选取字幕失败

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

// 级 3:yt-dlp 兜底。--ignore-no-formats-error 必需:
// 缺它则 format 选择阶段直接 "Requested format is not available" 中止,字幕不下载。
function tryYtDlp(videoId, cookiesPath) {
  const bin = resolveYtDlpBin();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `at-sub-${videoId}-`));
  try {
    const r = spawnSync(bin, [
      '--no-update', '--socket-timeout', '30',
      '--cookies', cookiesPath,
      '--skip-download', '--ignore-no-formats-error',
      '--write-auto-subs', '--sub-langs', 'en-orig,en', '--sub-format', 'json3',
      '-o', path.join(dir, 'sub'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { encoding: 'utf-8', timeout: 180_000 });
    if (r.error) throw new Error(r.error.message);

    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json3'));
    if (!file) throw new Error(`no json3 produced (exit ${r.status})`);
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

async function fetchCues(videoId, cookiesPath) {
  const attempts = [
    ['android', () => tryAndroid(videoId)],
    ['web+cookies', () => tryWebWithCookies(videoId, cookiesPath)],
    ['yt-dlp', async () => tryYtDlp(videoId, cookiesPath)],
  ];
  for (const [name, fn] of attempts) {
    try {
      const cues = await fn();
      if (cues && cues.length >= 10) {
        process.stderr.write(`  ✓ [${videoId}] ${name}: ${cues.length} cues\n`);
        return { cues, via: name };
      }
      process.stderr.write(`  ⚠ [${videoId}] ${name}: too few cues (${cues ? cues.length : 0})\n`);
    } catch (e) {
      process.stderr.write(`  ⚠ [${videoId}] ${name}: ${e.message}\n`);
    }
  }
  return null;
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
    '',
    'Exit: 0=成功 1=参数错 6=全部候选失败',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const args = { candidates: null, out: null, cookies: null, maxTry: 5 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--candidates': args.candidates = argv[++i]; break;
      case '--out': args.out = argv[++i]; break;
      case '--cookies': args.cookies = argv[++i]; break;
      case '--max-try': args.maxTry = parseInt(argv[++i], 10); break;
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

  const { candidates } = JSON.parse(fs.readFileSync(args.candidates, 'utf-8'));
  fs.mkdirSync(args.out, { recursive: true });

  // 逐个探测,第一个有字幕的胜出 —— IDC IP 上请求越少越安全
  for (const cand of candidates.slice(0, args.maxTry)) {
    const got = await fetchCues(cand.id, cookiesPath);
    if (!got) continue;

    const segments = mergeSegments(got.cues, { minSec: 30, maxSec: 60 });
    const fullText = got.cues.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim();

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
  resolveYtDlpBin, tryWebWithCookies,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`FATAL: ${e.message}\n`);
    process.exit(6);
  });
}
