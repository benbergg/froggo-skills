'use strict';
// channels.json 结构校验 + channelId 真实性核验(需 YOUTUBE_API_KEY)。
const path = require('node:path');
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const CFG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'references', 'channels.json'), 'utf-8')
);

test('T1: channels.json 结构完整', () => {
  assert.ok(Array.isArray(CFG.channels) && CFG.channels.length >= 5);
  for (const c of CFG.channels) {
    assert.match(c.handle, /^@/, `handle 需以 @ 开头: ${c.handle}`);
    assert.match(c.channelId, /^UC[A-Za-z0-9_-]{22}$/, `channelId 格式非法: ${c.handle} → ${c.channelId}`);
    assert.ok(c.weight > 0 && c.weight <= 1.0, `weight 越界: ${c.handle}`);
  }
});

test('T2: 关键词与打分参数齐备', () => {
  assert.ok(CFG.keywords.length >= 5);
  for (const k of CFG.keywords) {
    assert.equal(typeof k.pattern, 'string');
    assert.ok(k.bonus > 0 && k.bonus < 1);
  }
  const s = CFG.scoring;
  for (const key of ['keywordBase', 'keywordCap', 'durationShortSec', 'durationLongSec', 'recencyDecay', 'maxDurationSec']) {
    assert.equal(typeof s[key], 'number', `scoring.${key} 缺失`);
  }
});

// 联网核验:默认 skip(channelId 已于 2026-07-27 核验过,值是固定的)。
// 频道改名或新增频道时,用 AI_TALK_VERIFY_CHANNELS=1 打开。
// 不用 Data API —— 频道页 canonical 链接即可解析,无需 API key。
test('T3: channelId 与 handle 真实对应(联网,默认 skip)',
  { skip: !process.env.AI_TALK_VERIFY_CHANNELS }, async () => {
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
      + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    const bad = [];
    for (const c of CFG.channels) {
      const res = await fetch(`https://www.youtube.com/${c.handle}`, { headers: { 'User-Agent': UA } });
      if (!res.ok) { bad.push(`${c.handle}: HTTP ${res.status}`); continue; }
      const html = await res.text();
      const m = html.match(/rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/);
      if (!m) { bad.push(`${c.handle}: canonical 链接未找到`); continue; }
      if (m[1] !== c.channelId) bad.push(`${c.handle}: 配置 ${c.channelId} ≠ 实际 ${m[1]}`);
    }
    assert.deepEqual(bad, [], `channelId 核验失败:\n${bad.join('\n')}`);
  });
