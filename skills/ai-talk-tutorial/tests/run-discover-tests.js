'use strict';
// discover.js BDD 测试:打分公式、四类淘汰、零候选 exit 4、state 去重。
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runCli, FIXTURE, freshTmp } = require('./helpers');

const D = require('../references/scripts/discover.js');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'references', 'channels.json'), 'utf-8'));
const TODAY = '2026-07-27';

function vid(over = {}) {
  return {
    id: 'vid00000001', title: 'How we built an agentic coding system',
    channelTitle: 'AI Engineer', channelId: CFG.channels[0].channelId,
    publishedAt: '2026-07-27T02:00:00Z', duration: 'PT35M12S',
    description: '', liveBroadcastContent: 'none', ...over,
  };
}

test('T1: ISO 8601 时长解析', () => {
  assert.equal(D.parseDurationToSeconds('PT35M12S'), 2112);
  assert.equal(D.parseDurationToSeconds('PT1H2M3S'), 3723);
  assert.equal(D.parseDurationToSeconds('PT45S'), 45);
});

test('T2: 关键词命中提高分数', () => {
  const ch = CFG.channels[0];
  const hit = D.scoreVideo(vid({ title: 'How we built agentic evals' }), ch, CFG, TODAY);
  const miss = D.scoreVideo(vid({ title: 'Company holiday party recap' }), ch, CFG, TODAY);
  assert.ok(hit > miss, `命中(${hit}) 应高于未命中(${miss})`);
});

test('T3: 频道权重线性影响分数', () => {
  const high = CFG.channels.find((c) => c.weight === 1.0);
  const low = CFG.channels.find((c) => c.weight === 0.6);
  const a = D.scoreVideo(vid({ channelId: high.channelId }), high, CFG, TODAY);
  const b = D.scoreVideo(vid({ channelId: low.channelId }), low, CFG, TODAY);
  assert.ok(Math.abs(a / b - high.weight / low.weight) < 0.001);
});

test('T4: 时长过短降权', () => {
  const ch = CFG.channels[0];
  const short = D.scoreVideo(vid({ duration: 'PT3M' }), ch, CFG, TODAY);
  const ideal = D.scoreVideo(vid({ duration: 'PT35M' }), ch, CFG, TODAY);
  assert.ok(short < ideal * 0.5, `过短(${short}) 应显著低于理想(${ideal})`);
});

test('T5: 发布越久分数越低', () => {
  const ch = CFG.channels[0];
  const fresh = D.scoreVideo(vid({ publishedAt: '2026-07-27T02:00:00Z' }), ch, CFG, TODAY);
  const old = D.scoreVideo(vid({ publishedAt: '2026-07-20T02:00:00Z' }), ch, CFG, TODAY);
  assert.ok(fresh > old);
});

test('T6: 淘汰 — Shorts', () => {
  assert.equal(D.rejectReason(vid({ duration: 'PT45S' }), CFG, new Set()), 'shorts');
  assert.equal(D.rejectReason(vid({ title: 'Quick tip #shorts' }), CFG, new Set()), 'shorts');
});

test('T7: 淘汰 — 超长(>100min)', () => {
  assert.equal(D.rejectReason(vid({ duration: 'PT2H30M' }), CFG, new Set()), 'too_long');
});

test('T8: 淘汰 — 已处理', () => {
  assert.equal(D.rejectReason(vid({ id: 'seen1234567' }), CFG, new Set(['seen1234567'])), 'processed');
});

test('T9: 淘汰 — 直播进行中', () => {
  assert.equal(D.rejectReason(vid({ liveBroadcastContent: 'live' }), CFG, new Set()), 'live');
});

test('T10: 合格视频不被淘汰', () => {
  assert.equal(D.rejectReason(vid(), CFG, new Set()), null);
});

test('T11: CLI 从 fixture 产出 candidates.json,按分数降序', () => {
  const out = freshTmp();
  const r = runCli({ script: 'discover.js', args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json')] });
  try {
    assert.equal(r.code, 0, `expected 0, got ${r.code}: ${r.stderr}`);
    const c = JSON.parse(fs.readFileSync(path.join(out, 'candidates.json'), 'utf-8'));
    assert.ok(c.candidates.length >= 2);
    for (let i = 1; i < c.candidates.length; i++) {
      assert.ok(c.candidates[i - 1].score >= c.candidates[i].score, '未按分数降序');
    }
    assert.ok(c.candidates.every((x) => x.url.startsWith('https://www.youtube.com/watch?v=')));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});

test('T12: 全部被淘汰 → exit 4', () => {
  const out = freshTmp();
  const state = path.join(out, 'processed.json');
  const raw = JSON.parse(fs.readFileSync(FIXTURE('videos-api-ok.json'), 'utf-8'));
  fs.writeFileSync(state, JSON.stringify({ processed: raw.items.map((i) => i.id) }));
  const r = runCli({ script: 'discover.js', args: ['--out', out, '--from-file', FIXTURE('videos-api-ok.json'), '--state', state] });
  try {
    assert.equal(r.code, 4, `expected 4, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /no candidates/i);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    r.cleanup();
  }
});
