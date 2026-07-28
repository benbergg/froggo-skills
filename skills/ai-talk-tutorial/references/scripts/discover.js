#!/usr/bin/env node
'use strict';
// 从白名单频道发现候选视频并打分。
//
// 数据源:YouTube Data API v3(playlistItems 取 uploads → videos 取详情),
// 不用 yt-dlp —— 省配额、稳定、不触发反爬。
//
// 退出码:0=有候选 1=参数错 2=API 失败 4=零候选(正常业务分支,非错误)

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://www.googleapis.com/youtube/v3';

// ---- 纯函数(供测试直接引用) ------------------------------------------

function parseDurationToSeconds(iso) {
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] ?? '0', 10) * 3600)
       + (parseInt(m[2] ?? '0', 10) * 60)
       + (parseInt(m[3] ?? '0', 10));
}

function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso + 'T00:00:00Z').getTime();
  return Math.max(0, Math.floor((b - a) / 86400000));
}

// 关键词命中:基线 + 每个命中项 bonus,上限 keywordCap
function keywordFactor(video, cfg) {
  const hay = `${video.title} ${video.description || ''}`.toLowerCase();
  let f = cfg.scoring.keywordBase;
  for (const k of cfg.keywords) {
    if (hay.includes(k.pattern.toLowerCase())) f += k.bonus;
  }
  return Math.min(f, cfg.scoring.keywordCap);
}

function durationFactor(sec, cfg) {
  const s = cfg.scoring;
  if (sec < s.durationShortSec) return s.durationShortFactor;
  if (sec > s.durationLongSec) return s.durationLongFactor;
  return 1.0;
}

function scoreVideo(video, channel, cfg, today) {
  const sec = parseDurationToSeconds(video.duration);
  const recency = Math.pow(cfg.scoring.recencyDecay, daysBetween(video.publishedAt, today));
  return channel.weight * keywordFactor(video, cfg) * durationFactor(sec, cfg) * recency;
}

// 返回淘汰原因;通过则 null
// archivedSet 与 processedSet 分开传:两者都表示"已经出过",但来源不同,
// 混成一个集合会让 rejected 统计说不清是 state 记住的还是归档里翻出来的。
function rejectReason(video, cfg, processedSet, archivedSet = new Set()) {
  const sec = parseDurationToSeconds(video.duration);
  if (sec > 0 && sec < 60) return 'shorts';
  if (/#shorts/i.test(video.title)) return 'shorts';
  if (sec > cfg.scoring.maxDurationSec) return 'too_long';
  if (processedSet.has(video.id)) return 'processed';
  if (archivedSet.has(video.id)) return 'archived';
  if (video.liveBroadcastContent === 'live') return 'live';
  return null;
}

// ---- API 取数 ----------------------------------------------------------

async function apiGet(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Data API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// channelId(UCxxx) → uploads 播放列表 id(UUxxx):Data API 的固定映射规则
function uploadsPlaylistId(channelId) {
  return 'UU' + channelId.slice(2);
}

async function fetchChannelVideos(channel, apiKey, perChannel) {
  const plUrl = `${API}/playlistItems?part=contentDetails&playlistId=${uploadsPlaylistId(channel.channelId)}`
    + `&maxResults=${perChannel}&key=${apiKey}`;
  const pl = await apiGet(plUrl);
  const ids = (pl.items || []).map((i) => i.contentDetails.videoId).filter(Boolean);
  if (ids.length === 0) return [];

  const vUrl = `${API}/videos?part=snippet,contentDetails&id=${ids.join(',')}&key=${apiKey}`;
  const v = await apiGet(vUrl);
  return (v.items || []).map((i) => ({
    id: i.id,
    title: i.snippet.title,
    channelTitle: i.snippet.channelTitle,
    channelId: i.snippet.channelId,
    publishedAt: i.snippet.publishedAt,
    duration: i.contentDetails.duration,
    description: i.snippet.description || '',
    liveBroadcastContent: i.snippet.liveBroadcastContent || 'none',
  }));
}

// ---- CLI ---------------------------------------------------------------

function usage() {
  return [
    'Usage: discover.js --out <dir> [options]',
    '',
    '  --out <dir>          输出目录(必填),写入 candidates.json',
    '  --from-file <json>   从文件读视频列表代替调 API(测试用)',
    '  --state <path>       已处理 id 记录(默认 <out>/../state/processed.json)',
    '  --archive <dir>      归档根目录,扫其中 HTML 反查已出过的 video_id',
    '                       (默认取 env AI_TALK_ARCHIVE_DIR;不存在则跳过)',
    '  --per-channel <n>    每频道拉取条数(默认 10)',
    '  --today <YYYY-MM-DD> 覆盖当天日期(补跑用)',
    '',
    'Exit: 0=有候选 1=参数错 2=API 失败 4=零候选',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { out: null, fromFile: null, state: null, archive: null, perChannel: 10, today: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--out': out.out = argv[++i]; break;
      case '--from-file': out.fromFile = argv[++i]; break;
      case '--state': out.state = argv[++i]; break;
      case '--archive': out.archive = argv[++i]; break;
      case '--per-channel': out.perChannel = parseInt(argv[++i], 10); break;
      case '--today': out.today = argv[++i]; break;
      case '-h': case '--help': process.stdout.write(usage() + '\n'); process.exit(0);
      default:
        process.stderr.write(`Unknown flag: ${argv[i]}\n${usage()}\n`);
        process.exit(1);
    }
  }
  return out;
}

function loadProcessed(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return new Set();
  try {
    const o = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return new Set(Array.isArray(o.processed) ? o.processed : []);
  } catch (e) {
    // fix round(FR5):原实现静默吞掉损坏的 processed.json —— 去重状态无声归零,
    // 后果是重新选中已经发过的视频、重复生成并广播,运维侧没有任何信号。
    // 仍然返回空集合(不中止本次运行,损坏的去重状态不应阻断今天的候选发现),
    // 但必须留一条 WARN,让"去重状态本次失效"这件事不是完全无感的。
    process.stderr.write(`WARN: 无法解析 ${statePath}(${e.message}),去重状态本次失效,视为空集合\n`);
    return new Set();
  }
}

// 从归档目录里的 HTML 反查已经出过的 video_id。
//
// 为什么需要第二事实源:processed.json 由流水线末尾写入,归档由它前一步写入 ——
// 中间任何一步崩掉,就会出现"归档里躺着成品、state 里没记录"的状态(2026-07-28 实证),
// 次日重新选中同一个视频、重跑整条流水线。归档目录里的 HTML 是最硬的"已出过"证据。
//
// 只认 .html:归档同时落了 .md,但 HTML 才是 build-html.js 的正式产物,
// 认 .md 会把手工笔记之类的旁路文件也当成归档凭据。
function scanArchive(archiveDir) {
  const found = new Set();
  if (!archiveDir) return found;

  let st;
  try {
    st = fs.statSync(archiveDir);
  } catch {
    return found; // 目录尚不存在 = 首次运行,正常状态,不报警
  }
  if (!st.isDirectory()) {
    process.stderr.write(`WARN: --archive ${archiveDir} 不是目录,归档去重本次失效\n`);
    return found;
  }

  // 教程 HTML 里 video_id 出现在金句锚点(watch?v=)和文末嵌入(embed/)两处
  const RE = /youtube\.com\/(?:embed\/|watch\?v=)([A-Za-z0-9_-]{11})/g;
  const MAX_DEPTH = 3; // <archive>/<year>/<file>.html 只需 2 层,留一层余量

  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      process.stderr.write(`WARN: 无法读取归档目录 ${dir}(${e.message}),归档去重本次失效\n`);
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p, depth + 1); continue; }
      if (!ent.name.endsWith('.html')) continue;
      let html;
      try {
        html = fs.readFileSync(p, 'utf-8');
      } catch (e) {
        process.stderr.write(`WARN: 无法读取归档文件 ${p}(${e.message}),归档去重本次失效\n`);
        continue;
      }
      RE.lastIndex = 0;
      let m;
      while ((m = RE.exec(html)) !== null) found.add(m[1]);
    }
  };
  walk(archiveDir, 0);
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    process.stderr.write('--out is required\n' + usage() + '\n');
    process.exit(1);
  }
  const today = args.today || new Date().toISOString().slice(0, 10);
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'channels.json'), 'utf-8')
  );
  const statePath = args.state || path.join(args.out, '..', 'state', 'processed.json');
  const processed = loadProcessed(statePath);
  const archived = scanArchive(args.archive || process.env.AI_TALK_ARCHIVE_DIR || null);
  const byId = new Map(cfg.channels.map((c) => [c.channelId, c]));

  let videos = [];
  if (args.fromFile) {
    videos = JSON.parse(fs.readFileSync(args.fromFile, 'utf-8')).items || [];
  } else {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      process.stderr.write('FATAL: env YOUTUBE_API_KEY is required\n');
      process.exit(1);
    }
    for (const ch of cfg.channels) {
      try {
        const got = await fetchChannelVideos(ch, apiKey, args.perChannel);
        videos.push(...got);
        process.stderr.write(`${ch.handle}: ${got.length} videos\n`);
      } catch (e) {
        // 单频道失败不整体中止 —— 其余频道仍可产出候选
        process.stderr.write(`WARN ${ch.handle}: ${e.message}\n`);
      }
    }
    if (videos.length === 0) {
      process.stderr.write('FATAL: all channels failed\n');
      process.exit(2);
    }
  }

  const candidates = [];
  const rejected = {};
  for (const v of videos) {
    const ch = byId.get(v.channelId);
    if (!ch) { rejected[v.id] = 'not_whitelisted'; continue; }
    const why = rejectReason(v, cfg, processed, archived);
    if (why) { rejected[v.id] = why; continue; }
    candidates.push({
      id: v.id,
      title: v.title,
      channelTitle: v.channelTitle,
      channelHandle: ch.handle,
      publishedAt: v.publishedAt,
      durationSec: parseDurationToSeconds(v.duration),
      score: Number(scoreVideo(v, ch, cfg, today).toFixed(4)),
      url: `https://www.youtube.com/watch?v=${v.id}`,
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(
    path.join(args.out, 'candidates.json'),
    JSON.stringify({ generated_at: today, candidates, rejected }, null, 2) + '\n'
  );

  const counts = Object.values(rejected).reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {});
  process.stderr.write(
    `candidates=${candidates.length} archived=${archived.size} rejected=${JSON.stringify(counts)}\n`
  );

  if (candidates.length === 0) {
    process.stderr.write('no candidates today\n');
    process.exit(4);
  }
  process.exit(0);
}

module.exports = {
  parseDurationToSeconds, keywordFactor, durationFactor, scoreVideo,
  rejectReason, uploadsPlaylistId, scanArchive,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`FATAL: ${e.message}\n`);
    process.exit(2);
  });
}
