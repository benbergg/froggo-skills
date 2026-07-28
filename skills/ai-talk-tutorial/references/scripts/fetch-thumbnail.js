#!/usr/bin/env node
'use strict';
// selected.json → 抓 YouTube 官方封面 → base64 内嵌 → thumbnail.json
//
// 为什么内嵌而不是外链:归档 HTML 要在知识库里躺很多年,视频被删/转私有后
// i.ytimg.com 会 404,外链封面变成一个碎图标。base64 之后归档自带图,与视频存亡无关。
// (页脚的 <iframe> 原视频本来就依赖 YouTube 在线,那是"看原片"的入口,坏了不影响读文章;
//  封面是版面的一部分,坏了直接破版 —— 两者容忍度不同,所以只对封面做内嵌。)
//
// 为什么不用 yt-dlp 抓 storyboard 逐时间戳配图:2026-07-28 实测 VM 上 yt-dlp 已因
// cookie 轮换 + 缺 JS runtime 失效。i.ytimg.com 这几个端点免认证、免 cookie,
// 是整条链路里最不容易坏的一环,插图能力不该挂在最脆的依赖上。
//
// 本步失败不阻断流水线:没有封面就退回纯色页头,文章照常出。
//
// 退出码:0=成功或已降级(无论是否取到图) 1=参数错

const fs = require('node:fs');
const path = require('node:path');

// 按画质从高到低,取到第一个满足体积上限的就停。
// maxresdefault 并非所有视频都有(老视频/低清上传会 404),必须有降级链。
const VARIANTS = [
  { name: 'maxresdefault', w: 1280, h: 720 },
  { name: 'sddefault', w: 640, h: 480 },
  { name: 'hqdefault', w: 480, h: 360 },
];

const DEFAULT_MAX_KB = 400;
const FETCH_TIMEOUT_MS = 20000;

function usage() {
  return [
    'Usage: fetch-thumbnail.js --selected <path> --out <dir> [--max-kb N]',
    '',
    '产出 <dir>/thumbnail.json = { video_id, variant, mime, bytes, data_uri }',
    '取不到图时不写文件,exit 0(下游 build-html.js 自行退回纯色页头)',
    '',
    'Exit: 0=正常(含"没取到"这一情形) 1=参数错',
  ].join('\n');
}

// 单个候选画质:抓 → 校验是真图 → 校验体积 → 返回 buffer;任一不满足返回 null。
async function tryVariant(videoId, variant, maxBytes) {
  const url = `https://i.ytimg.com/vi/${videoId}/${variant.name}.jpg`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // YouTube 对不存在的画质返回 200 + 一张 120x90 的灰色占位图(约 1KB),
    // 不是 404 —— 只看 res.ok 会把占位图当成封面内嵌进去。用体积下界排掉。
    if (buf.length < 4096) return null;
    // JPEG magic:FF D8 FF。防的是代理/网关返回一段 HTML 错误页而 content-type 撒谎。
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return null;
    // base64 膨胀约 4/3,按编码后体积卡上限才是 HTML 实际增量
    if (Math.ceil(buf.length / 3) * 4 > maxBytes) return null;
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchThumbnail(videoId, maxBytes) {
  const skipped = [];
  for (const variant of VARIANTS) {
    const buf = await tryVariant(videoId, variant, maxBytes);
    if (buf) {
      return {
        video_id: videoId,
        variant: variant.name,
        width: variant.w,
        height: variant.h,
        mime: 'image/jpeg',
        bytes: buf.length,
        data_uri: `data:image/jpeg;base64,${buf.toString('base64')}`,
        skipped,
      };
    }
    skipped.push(variant.name);
  }
  return null;
}

async function main() {
  // Happy Eyeballs:2026-07-28 实测,某些网络下 DNS 会给 i.ytimg.com 返回一个不可达的
  // AAAA(如 Teredo 前缀 2001::1),Node 的 fetch 认死 IPv6 直接 10s connect timeout,
  // 同一台机器上 curl 却正常 —— 因为 curl 会回落 IPv4。开这个开关让 Node 也回落。
  // 放在 main() 里而不是模块顶层:它改的是进程级默认值,不该在被 require 时就生效。
  try { require('node:net').setDefaultAutoSelectFamily(true); } catch { /* 旧 Node 无此 API */ }

  const argv = process.argv.slice(2);
  const args = { selected: null, out: null, maxKb: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--selected': args.selected = argv[++i]; break;
      case '--out': args.out = argv[++i]; break;
      case '--max-kb': args.maxKb = parseInt(argv[++i], 10); break;
      case '-h': case '--help': process.stdout.write(usage() + '\n'); return 0;
      default:
        process.stderr.write(`Unknown flag: ${argv[i]}\n${usage()}\n`);
        return 1;
    }
  }
  for (const k of ['selected', 'out']) {
    if (!args[k]) { process.stderr.write(`--${k} is required\n${usage()}\n`); return 1; }
  }

  const envKb = parseInt(process.env.AI_TALK_THUMB_MAX_KB || '', 10);
  const maxKb = Number.isFinite(args.maxKb) && args.maxKb > 0 ? args.maxKb
    : (Number.isFinite(envKb) && envKb > 0 ? envKb : DEFAULT_MAX_KB);

  let selected;
  try {
    selected = JSON.parse(fs.readFileSync(args.selected, 'utf-8'));
  } catch (e) {
    // selected.json 读不动是上游的问题,但封面不是关键路径,照样不阻断
    process.stderr.write(`WARN: 读不到 --selected ${args.selected}(${e.message}),跳过封面\n`);
    return 0;
  }
  if (!selected || !selected.id) {
    process.stderr.write('WARN: selected.json 缺 id 字段,跳过封面\n');
    return 0;
  }

  const result = await fetchThumbnail(selected.id, maxKb * 1024);
  if (!result) {
    process.stderr.write(`WARN: ${selected.id} 三档封面(${VARIANTS.map((v) => v.name).join('/')})`
      + `均不可用或超过 ${maxKb}KB 上限,本篇无封面大图\n`);
    return 0;
  }

  fs.mkdirSync(args.out, { recursive: true });
  const outPath = path.join(args.out, 'thumbnail.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  const skipNote = result.skipped.length > 0 ? `(跳过 ${result.skipped.join('/')})` : '';
  process.stderr.write(`封面 ${result.variant} ${Math.round(result.bytes / 1024)}KB${skipNote} → ${outPath}\n`);
  return 0;
}

module.exports = { fetchThumbnail, tryVariant, VARIANTS, DEFAULT_MAX_KB };

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`WARN: 封面抓取异常(${e.message}),跳过\n`);
    process.exit(0);
  });
}
