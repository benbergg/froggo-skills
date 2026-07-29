'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteText, atomicWriteJSON } = require('./atomic-write');

const keyOf = (r) => `${r.observed_date}|${r.vintage}`;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const byObservedDateAsc = (a, b) => (a.observed_date < b.observed_date ? -1 : a.observed_date > b.observed_date ? 1 : 0);

function assertIsoDate(value, label) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw new Error(`history-store: ${label} 必须是 YYYY-MM-DD 格式的字符串,实得 ${JSON.stringify(value)}`);
  }
}

// 并发安全边界(用户已裁定不做 per-series 文件锁):
// upsert/setMeta 是无锁读-改-写,两个进程同时写同一 series 会 lost update
// (实测同 key 各写 150 次、应保留 300 条,五次运行只落 152/103/152/154/153 条)。
// 不在这里加锁的前提是:同一 series 同一时刻只应有一个写进程,由编排层用 flock 保证串行;
// 库层加锁只是把本该在编排层解决的问题伪装成"已加固",反而掩盖真正的调用方 bug。
// atomic-write.js 保证的是"不产生更差的结果"——不会把已提交文件写坏、不会崩成 ENOENT,
// 不保证"两个并发写都不丢"。
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
    rows.sort(byObservedDateAsc);
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

  // availableOn 是防前视偏差的唯一开关,必须显式传:
  //   - 合法 YYYY-MM-DD 字符串 → 按「该日当时能看到的最新修订」过滤
  //   - 显式 { availableOn: null } → 明确选择读取全部(等价 readAll)
  //   - 完全不传第二个参数 / 传非法日期 → 抛错,不静默退化
  // 三种绕过全部实测过:(a) 记录缺 available_date 时 `undefined > x` 恒 false,
  // 过滤形同虚设;(b) 不传 availableOn 曾默认返回全部,调用方以为自己防住了前视;
  // (c) 非法日期字符串曾静默退化成不设防,是三者里最隐蔽的一种——不报错所以永远不会被发现。
  read(series, opts) {
    if (opts === undefined || opts === null) {
      throw new Error(
        'history-store.read: 必须显式传 { availableOn: "YYYY-MM-DD" } 限定可见日期,'
        + '或调用 readAll(series) / 显式传 { availableOn: null } 表示有意读取全部'
        + '(防止「忘了传」和「有意读全部」长得一样)'
      );
    }
    if (!('availableOn' in opts)) {
      throw new Error('history-store.read: opts 缺少 availableOn 字段,同上——必须显式声明意图');
    }
    const { availableOn } = opts;
    if (availableOn === null) return this.readAll(series);
    assertIsoDate(availableOn, 'availableOn');

    const rows = this._all(series);
    // 同一 observed_date 保留 available_date 最大且不晚于 availableOn 的那版,
    // 即「该日当时能看到的最新修订」。这条是防前视偏差的关键。
    const best = new Map();
    for (const r of rows) {
      if (r.available_date === undefined || r.available_date === null) {
        // undefined > x 恒 false,过滤会静默放行——宁可让这条脏数据毒死整个序列的读取,
        // 也不让它悄悄冒充"不可见"混过前视检查。
        throw new Error(
          `history-store.read: series=${series} 存在记录缺失 available_date`
          + `(observed_date=${r.observed_date}),前视过滤无法判定可见性`
        );
      }
      if (r.available_date > availableOn) continue;
      const cur = best.get(r.observed_date);
      if (!cur || r.available_date > cur.available_date) best.set(r.observed_date, r);
    }
    return [...best.values()].sort(byObservedDateAsc);
  }

  // 显式的「读全部、不设防」入口,不做前视过滤,不要求 available_date 存在。
  readAll(series) {
    return this._all(series).sort(byObservedDateAsc);
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
