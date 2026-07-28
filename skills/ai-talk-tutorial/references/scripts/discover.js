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

// 判定视频主题。候选范围限于该频道声明的 topics(顺序即优先级),
// 在其中取命中关键词最多的一组;都不中则取第一个作为兜底。
//
// 为什么由内容判而不是直接用频道主题:SaaStr 的 "From 0 to 20 Agents and Back Again"
// 内容是 agentic 不是 saas,按频道一刀切会让主题统计失真,连带主题降权也算错。
// 平局取靠前者(用 > 而非 >=)使结果稳定可测 —— 频道 topics 的书写顺序就是它的主业。
// 只看标题,**不看 description** —— 2026-07-28 VM 实测:
// "The Messy Reality of Scale: Synthetic Data and Pre-Training" 只按标题算是
// ai-tech 2 : agentic 0,加上 description 后却被判成 agentic。原因是会议类频道
// 给每条视频挂同一段宣传语,描述里永远塞满该频道主业的词 —— 描述这一票
// 恒定投给频道的主题,"按内容判主题"就退化成了"按频道判主题"。
// 标题是视频对自己的声明,描述是频道的模板文案,两者可信度不同。
// (description 仍参与 keywordFactor:那里命中越多说明 how-to 信息越密,没有这个偏置问题。)
function topicOf(video, channel, cfg) {
  if (!cfg.topics) return null;
  const hay = String(video.title || '').toLowerCase();
  const allowed = (channel && Array.isArray(channel.topics) && channel.topics.length > 0)
    ? channel.topics : Object.keys(cfg.topics);
  let best = null;
  let bestHits = 0;
  for (const t of allowed) {
    const grp = cfg.topics[t];
    if (!grp || !Array.isArray(grp.keywords)) continue;
    const hits = grp.keywords.filter((k) => hay.includes(k.pattern.toLowerCase())).length;
    if (hits > bestHits) { bestHits = hits; best = t; }
  }
  return best || allowed[0] || null;
}

// 关键词命中:基线 + 通用词 bonus + 所属主题组的 bonus,上限 keywordCap。
//
// 分组的理由(2026-07-28 实测):原来只有一张全是 AI 词的表,拿五个频道的真实标题跑,
// 全部落在 0.70-0.82 之间 —— keywordCap 1.6 从没被接近过,这张表实际上是失效的,
// 排序完全由 channel.weight × recency 决定。分组后每个主题都有自己够得着的加分项,
// 产品/SaaS 类视频不再因为"没提 agent"就永远停在基线。
function keywordFactor(video, cfg, topic) {
  const hay = `${video.title} ${video.description || ''}`.toLowerCase();
  let f = cfg.scoring.keywordBase;
  for (const k of cfg.keywords) {
    if (hay.includes(k.pattern.toLowerCase())) f += k.bonus;
  }
  const grp = topic && cfg.topics ? cfg.topics[topic] : null;
  if (grp && Array.isArray(grp.keywords)) {
    for (const k of grp.keywords) {
      if (hay.includes(k.pattern.toLowerCase())) f += k.bonus;
    }
  }
  return Math.min(f, cfg.scoring.keywordCap);
}

function durationFactor(sec, cfg) {
  const s = cfg.scoring;
  if (sec < s.durationShortSec) return s.durationShortFactor;
  if (sec > s.durationLongSec) return s.durationLongFactor;
  return 1.0;
}

// 频道多样性衰减:近 diversityDays 天内该频道每出过一次,分数乘一次 diversityPenalty。
//
// 2026-07-28 实证:当天产出的两篇都来自 AI Engineer,打分公式里没有任何一项在管
// "最近是不是老出同一家"。做成**降权**而不是排除 —— 某天确实只有那个频道有好内容时
// 仍然该选它,只是要先被别的频道公平比一比。窗口是滑动的,不是永久黑名单。
function diversityFactor(channel, cfg, today, history) {
  if (!channel || !channel.handle || !Array.isArray(history) || history.length === 0) return 1;
  const days = cfg.scoring.diversityDays ?? 7;
  const penalty = cfg.scoring.diversityPenalty ?? 0.55;
  const n = history.filter(
    (h) => h && h.channel === channel.handle && h.date && daysBetween(h.date, today) < days
  ).length;
  return Math.pow(penalty, n);
}

// 主题降权:近 topicDays 天内该主题每出过一次,分数乘一次 topicPenalty。
//
// 为什么光加频道不够(2026-07-28 实测):按 90 天内落在时长区间的产出算,
// LatentSpace 约 6 天一篇、Lenny's 约 18 天一篇。recencyDecay=0.85 下
// 6 天前剩 0.38、18 天前只剩 0.054 —— 产品/设计类天生扛着 7 倍衰减劣势,
// 只把频道加进白名单,它们一天也选不上,主题扩展会停留在配置文件里。
//
// 与频道降权同构且相乘:同频道同主题连出两天会被压到 0.55×0.5=0.275,
// 换个主题的频道则是 1.0,足以强制轮换。窗口滑动,不是永久黑名单。
function topicFactor(topic, cfg, today, history) {
  if (!topic || !Array.isArray(history) || history.length === 0) return 1;
  const days = cfg.scoring.topicDays ?? 5;
  const penalty = cfg.scoring.topicPenalty ?? 0.5;
  const n = history.filter(
    (h) => h && h.topic === topic && h.date && daysBetween(h.date, today) < days
  ).length;
  return Math.pow(penalty, n);
}

function scoreVideo(video, channel, cfg, today, history = []) {
  const sec = parseDurationToSeconds(video.duration);
  const topic = topicOf(video, channel, cfg);
  const recency = Math.pow(cfg.scoring.recencyDecay, daysBetween(video.publishedAt, today));
  return channel.weight * keywordFactor(video, cfg, topic) * durationFactor(sec, cfg) * recency
    * diversityFactor(channel, cfg, today, history) * topicFactor(topic, cfg, today, history);
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

// 出片历史(频道多样性用)。旧格式 state 没有 history 字段 —— 返回空数组即可,
// 不 WARN:去重是主线功能,不能被多样性这个次要特性拖出噪音。
function loadHistory(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return [];
  try {
    const o = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return Array.isArray(o.history) ? o.history : [];
  } catch {
    return []; // 损坏已由 loadProcessed 报过 WARN,这里不重复刷屏
  }
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
  const history = loadHistory(statePath);
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
      topic: topicOf(v, ch, cfg),
      publishedAt: v.publishedAt,
      durationSec: parseDurationToSeconds(v.duration),
      score: Number(scoreVideo(v, ch, cfg, today, history).toFixed(4)),
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
  // 主题分布报出来:主题扩展有没有真的生效,看这一行就知道 —— 长期只有一个 topic
  // 说明降权参数或频道 topics 标错了,不该等到人翻归档才发现
  const topics = candidates.reduce((m, c) => (m[c.topic || '?'] = (m[c.topic || '?'] || 0) + 1, m), {});
  process.stderr.write(
    `candidates=${candidates.length} archived=${archived.size}`
    + ` topics=${JSON.stringify(topics)} rejected=${JSON.stringify(counts)}\n`
  );

  if (candidates.length === 0) {
    process.stderr.write('no candidates today\n');
    process.exit(4);
  }
  process.exit(0);
}

module.exports = {
  parseDurationToSeconds, keywordFactor, durationFactor, scoreVideo,
  rejectReason, uploadsPlaylistId, scanArchive, diversityFactor, topicOf, topicFactor,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`FATAL: ${e.message}\n`);
    process.exit(2);
  });
}
