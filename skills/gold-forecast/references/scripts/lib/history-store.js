'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteText, atomicWriteJSON } = require('./atomic-write');

const keyOf = (r) => `${r.observed_date}|${r.vintage}`;

class HistoryStore {
  constructor(rootDir) {
    this.root = rootDir;
    fs.mkdirSync(rootDir, { recursive: true });
  }

  _file(series) {
    return path.join(this.root, `${series}.jsonl`);
  }

  _all(series) {
    const f = this._file(series);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  _write(series, rows) {
    rows.sort((a, b) => (a.observed_date < b.observed_date ? -1 : a.observed_date > b.observed_date ? 1 : 0));
    atomicWriteText(this._file(series), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  upsert(series, records) {
    const rows = this._all(series);
    const index = new Map(rows.map((r, i) => [keyOf(r), i]));
    let inserted = 0;
    let updated = 0;
    for (const rec of records) {
      const k = keyOf(rec);
      if (index.has(k)) { rows[index.get(k)] = { ...rows[index.get(k)], ...rec }; updated++; }
      else { index.set(k, rows.length); rows.push(rec); inserted++; }
    }
    this._write(series, rows);
    return { inserted, updated };
  }

  read(series, { availableOn = null } = {}) {
    let rows = this._all(series);
    if (availableOn) {
      // 同一 observed_date 保留 available_date 最大且不晚于 availableOn 的那版,
      // 即「该日当时能看到的最新修订」。这条是防前视偏差的关键。
      const best = new Map();
      for (const r of rows) {
        if (r.available_date > availableOn) continue;
        const cur = best.get(r.observed_date);
        if (!cur || r.available_date > cur.available_date) best.set(r.observed_date, r);
      }
      rows = [...best.values()];
    }
    return rows.sort((a, b) => (a.observed_date < b.observed_date ? -1 : a.observed_date > b.observed_date ? 1 : 0));
  }

  remove(series, keys) {
    const drop = new Set(keys.map(keyOf));
    const rows = this._all(series);
    const kept = rows.filter((r) => !drop.has(keyOf(r)));
    this._write(series, kept);
    return rows.length - kept.length;
  }

  meta() {
    const f = path.join(this.root, 'meta.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : {};
  }

  setMeta(patch) {
    atomicWriteJSON(path.join(this.root, 'meta.json'), { ...this.meta(), ...patch });
  }
}

module.exports = { HistoryStore };
