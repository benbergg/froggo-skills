'use strict';
// fetch-transcript.js BDD 测试:XML 双格式解析(保留时间戳)、段落合并、cookie 解析、时间戳格式化。
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURE } = require('./helpers');

const F = require('../references/scripts/fetch-transcript.js');

test('T1: srv3 格式解析并保留时间戳', () => {
  const cues = F.parseTimedTextXml(fs.readFileSync(FIXTURE('timedtext-srv3.xml'), 'utf-8'));
  assert.ok(cues.length >= 3, `期望 ≥3 条,实际 ${cues.length}`);
  assert.equal(typeof cues[0].tMs, 'number');
  assert.ok(cues[0].text.length > 0);
  for (let i = 1; i < cues.length; i++) {
    assert.ok(cues[i].tMs >= cues[i - 1].tMs, '时间戳应单调不减');
  }
});

test('T2: classic 格式解析并保留时间戳', () => {
  const cues = F.parseTimedTextXml(fs.readFileSync(FIXTURE('timedtext-classic.xml'), 'utf-8'));
  assert.ok(cues.length >= 2);
  assert.equal(cues[0].tMs, 1500, 'start="1.5" 应转成 1500ms');
});

test('T3: HTML 实体解码', () => {
  const cues = F.parseTimedTextXml('<transcript><text start="0" dur="1">it&amp;#39;s &amp;quot;fine&amp;quot;</text></transcript>');
  assert.match(cues[0].text, /it's "fine"/);
});

test('T4: 段落合并到 30-60 秒窗口', () => {
  const cues = [];
  for (let i = 0; i < 120; i++) cues.push({ tMs: i * 2000, text: `word${i}` });  // 每 2 秒一条,共 240 秒
  const segs = F.mergeSegments(cues, { minSec: 30, maxSec: 60 });
  assert.ok(segs.length >= 4 && segs.length <= 9, `期望 4-9 段,实际 ${segs.length}`);
  for (const s of segs) {
    assert.match(s.startLabel, /^\d{1,2}:\d{2}$/);
    assert.ok(s.text.length > 0);
  }
  assert.equal(segs[0].start, 0);
});

test('T5: 合并不丢词', () => {
  const cues = [{ tMs: 0, text: 'alpha' }, { tMs: 1000, text: 'beta' }, { tMs: 2000, text: 'gamma' }];
  const segs = F.mergeSegments(cues, { minSec: 30, maxSec: 60 });
  assert.equal(segs.map((s) => s.text).join(' '), 'alpha beta gamma');
});

test('T6: 时间戳格式化', () => {
  assert.equal(F.formatTimestamp(0), '0:00');
  assert.equal(F.formatTimestamp(75), '1:15');
  assert.equal(F.formatTimestamp(3725), '62:05');
});

test('T7: Netscape cookie 文件解析', () => {
  const raw = [
    '# Netscape HTTP Cookie File',
    '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc123',
    '.youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-3PAPISID\txyz789',
  ].join('\n');
  const s = F.parseCookieString(raw);
  assert.match(s, /SID=abc123/);
  assert.match(s, /__Secure-3PAPISID=xyz789/);
});

test('T8: 空/注释-only cookie 文件 → null', () => {
  assert.equal(F.parseCookieString('# only a comment\n'), null);
});
