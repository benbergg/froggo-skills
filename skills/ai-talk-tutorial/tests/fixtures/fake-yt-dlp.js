#!/usr/bin/env node
'use strict';
// 测试替身:模拟 yt-dlp 的真实行为(含 2026-07-29 VM 实测的三类失败 stderr)。
//
// 为什么要这个替身:真 yt-dlp 会打 YouTube,而本轮修的恰恰是"打不通时怎么办"。
// 更关键的是它会就地回写 --cookies 文件 —— 这个副作用只有替身能确定性复现。
//
// env 开关:
//   FAKE_YTDLP_PLAN    JSON,按 videoId 分派行为:{"<id>":{"mode":"ok|thin|fail","cues":N,"stderr":"…"}}
//                      未列出的 id 走下面的全局默认
//   FAKE_YTDLP_STDERR  默认输出到 stderr 的内容
//   FAKE_YTDLP_TAMPER  =1 时往 --cookies 指向的文件写垃圾(复现 cookie 侵蚀)
//   FAKE_YTDLP_JSON3   =1 时按 -o 前缀产出 json3 字幕
//   FAKE_YTDLP_CUES    产出多少条 cue(默认 40)
//   FAKE_YTDLP_EXIT    进程退出码(默认 0 —— 真 yt-dlp 取不到字幕时也退 0)

const fs = require('node:fs');

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};

const url = argv[argv.length - 1] || '';
const videoId = (url.match(/[?&]v=([A-Za-z0-9_-]{11})/) || [])[1] || '';

let plan = {};
try {
  plan = JSON.parse(process.env.FAKE_YTDLP_PLAN || '{}');
} catch {
  plan = {};
}
const step = plan[videoId] || null;

const cookiePath = valueOf('--cookies');
if (process.env.FAKE_YTDLP_TAMPER === '1' && cookiePath) {
  fs.writeFileSync(cookiePath, '# TAMPERED BY FAKE YT-DLP\n');
}

// 每条 cue 约 100 字符 —— 贴近真实转录密度(实测 523-1012 chars/min)
const cueText = (i) =>
  `this is fake transcript cue number ${i} carrying roughly one hundred characters of plausible speech text.`;

const mode = step ? step.mode : (process.env.FAKE_YTDLP_JSON3 === '1' ? 'ok' : 'fail');
const cues = step && step.cues != null
  ? step.cues
  : parseInt(process.env.FAKE_YTDLP_CUES || '40', 10);

if (mode === 'ok' || mode === 'thin') {
  const prefix = valueOf('-o');
  const events = [];
  for (let i = 0; i < cues; i++) {
    events.push({ tStartMs: i * 3000, segs: [{ utf8: cueText(i) }] });
  }
  fs.writeFileSync(`${prefix}.en.json3`, JSON.stringify({ events }));
}

const stderr = (step && step.stderr) || process.env.FAKE_YTDLP_STDERR || '';
if (stderr) process.stderr.write(stderr + '\n');

process.exit(parseInt(process.env.FAKE_YTDLP_EXIT || '0', 10));
