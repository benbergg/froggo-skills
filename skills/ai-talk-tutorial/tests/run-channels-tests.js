'use strict';
// channels.json 结构校验 + channelId 真实性核验(联网核验,默认 skip;不用 Data API,见下方 T3 注释)。
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

// ── 主题分组(2026-07-28):topics 与 channels[].topics 的一致性 ──────────
// 这几条不是形式校验:topic id 写错一个字母,topicOf 会静默退回频道第一个主题,
// 主题降权跟着算错,而 candidates.json 里看起来一切正常。

test('T4: topics 结构完整,每组都有 label 与可用关键词', () => {
  assert.ok(CFG.topics && typeof CFG.topics === 'object', '缺 topics');
  const ids = Object.keys(CFG.topics);
  assert.ok(ids.length >= 3, `主题数过少: ${ids.length}`);
  for (const id of ids) {
    const t = CFG.topics[id];
    assert.equal(typeof t.label, 'string', `topics.${id}.label 缺失`);
    assert.ok(Array.isArray(t.keywords) && t.keywords.length >= 5,
      `topics.${id}.keywords 过少,该主题的视频将长期停在 keywordBase`);
    for (const k of t.keywords) {
      assert.equal(typeof k.pattern, 'string');
      assert.ok(k.bonus > 0 && k.bonus < 1, `topics.${id} 的 bonus 越界: ${k.pattern}`);
    }
  }
});

test('T5: 每个频道都声明 topics,且引用的主题 id 都存在', () => {
  const ids = new Set(Object.keys(CFG.topics));
  const bad = [];
  for (const c of CFG.channels) {
    if (!Array.isArray(c.topics) || c.topics.length === 0) { bad.push(`${c.handle}: 未声明 topics`); continue; }
    for (const t of c.topics) if (!ids.has(t)) bad.push(`${c.handle}: 引用了不存在的主题 "${t}"`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('T6: 每个主题至少有一个频道供给(否则该主题永远不会出片)', () => {
  const covered = new Set(CFG.channels.flatMap((c) => c.topics || []));
  const orphan = Object.keys(CFG.topics).filter((t) => !covered.has(t));
  assert.deepEqual(orphan, [], `这些主题没有任何频道声明,配了也不会有内容: ${orphan.join(', ')}`);
});

test('T7: 主题降权参数齐备', () => {
  for (const key of ['topicDays', 'topicPenalty', 'diversityDays', 'diversityPenalty']) {
    assert.equal(typeof CFG.scoring[key], 'number', `scoring.${key} 缺失`);
  }
  assert.ok(CFG.scoring.topicPenalty > 0 && CFG.scoring.topicPenalty < 1);
});
