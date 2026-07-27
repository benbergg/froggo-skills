#!/usr/bin/env node
'use strict';
// 扫描归档目录重建 index.html。幂等:每次全量重建,不做增量。

const fs = require('node:fs');
const path = require('node:path');

// fix round(FR3):build-html.js 的 esc() 补上了 " → &quot; 转义(它被用在 title=".."/href=".."
// 属性上下文,不转义会导致属性提前闭合),href="..." 这里同样是属性上下文,一并加,理由相同。
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// esc() 的逆运算:归档 HTML 里的 <title> 内容在 Task 4 build-html.js 写入时已被 esc() 转义过一遍,
// collect() 截取到的是转义后的明文实体,必须先解码回原始字符,交给 render() 的 esc() 重新转义一次,
// 否则会叠加成双重转义(如 "Bug & Fix" 显示成 "Bug &amp;amp; Fix")。
// 解码顺序不能颠倒:必须先解 &lt;/&gt;/&quot;,最后才解 &amp; —— 反过来会把 "&amp;lt;" 误解成 "<"。
// fix round(FR3):esc() 加了 &quot; 转义后,<title> 里可能出现 &quot;,必须同步支持解码,
// 否则会被 render() 的 esc() 二次转义成 &amp;quot;(与 &lt;/&gt; 同一类问题)。
function unesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function collect(root) {
  const rows = [];
  for (const year of fs.readdirSync(root)) {
    const yDir = path.join(root, year);
    if (!fs.statSync(yDir).isDirectory() || !/^\d{4}$/.test(year)) continue;
    for (const f of fs.readdirSync(yDir)) {
      if (!f.endsWith('.html') || f === 'index.html') continue;
      const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.html$/);
      if (!m) continue;
      const raw = fs.readFileSync(path.join(yDir, f), 'utf-8');
      const t = raw.match(/<title>([\s\S]*?)<\/title>/i);
      rows.push({ date: m[1], href: `${year}/${f}`, title: t ? unesc(t[1].trim()) : m[2] });
    }
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows;
}

function render(rows) {
  const items = rows.map((r) =>
    `  <li><span class="d">${esc(r.date)}</span><a href="${esc(r.href)}">${esc(r.title)}</a></li>`
  ).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI 演讲教程 · 归档</title>
<style>
:root{--bg:#EEF1F6;--ink:#14161F;--soft:#5A6072;--brand:#5B44E4;--line:#C9D0DE;--panel:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#111319;--ink:#ECEEF5;--soft:#A2A9BC;--brand:#8F7CF5;--line:#2C3140;--panel:#191C25}}
body{margin:0;background:var(--bg);color:var(--ink);line-height:1.7;
  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:48px 20px}
h1{font-size:28px;margin:0 0 8px}
p.sub{color:var(--soft);margin:0 0 28px}
ul{list-style:none;padding:0;margin:0}
li{display:flex;gap:14px;align-items:baseline;padding:12px 14px;background:var(--panel);
  border:1px solid var(--line);border-radius:10px;margin-bottom:8px}
.d{color:var(--soft);font-size:13px;font-variant-numeric:tabular-nums;flex:0 0 auto}
a{color:var(--brand);text-decoration:none}
a:hover{text-decoration:underline}
@media (max-width:600px){li{flex-direction:column;gap:2px}}
</style>
</head>
<body><div class="wrap">
<h1>AI 演讲教程 · 归档</h1>
<p class="sub">共 ${rows.length} 篇 · 由 ai-talk-tutorial 每日自动生成</p>
<ul>
${items}
</ul>
</div></body>
</html>
`;
}

function main() {
  const argv = process.argv.slice(2);
  let dir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      process.stdout.write('Usage: build-index.js --dir <归档根目录>\n');
      process.exit(0);
    } else {
      process.stderr.write(`Unknown flag: ${argv[i]}\n`);
      process.exit(1);
    }
  }
  if (!dir) {
    process.stderr.write('--dir is required\n');
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  const rows = collect(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), render(rows));
  process.stderr.write(`index rebuilt: ${rows.length} entries\n`);
  process.exit(0);
}

module.exports = { collect, render };

if (require.main === module) main();
