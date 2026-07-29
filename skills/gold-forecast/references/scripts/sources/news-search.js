'use strict';
const { spawnSync } = require('node:child_process');

const OPENCLAW = process.env.OPENCLAW_BIN || `${process.env.HOME}/.npm-global/bin/openclaw`;

// 只保留标题/链接/时间/来源。正文不取 —— 它进 prompt 就是注入入口。
function normalize(items) {
  return items.slice(0, 12).map((it) => ({
    title: String(it.title || '').slice(0, 200),
    url: String(it.url || ''),
    published_at: it.published_at || it.date || null,
    source: String(it.source || '').slice(0, 80),
  })).filter((it) => /^https?:\/\//.test(it.url));
}

function fetchNews({ query = 'gold price XAU', timeoutMs = 45_000 } = {}) {
  const r = spawnSync(OPENCLAW, ['infer', 'web', 'search', '--json', '--query', query],
    { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 16 << 20 });
  if (r.status !== 0) return { records: [], status: 'missing' };
  try {
    const j = JSON.parse(r.stdout);
    return { records: normalize(j.results || j.outputs || []), status: 'ok' };
  } catch { return { records: [], status: 'missing' }; }
}

module.exports = { normalize, fetchNews };
