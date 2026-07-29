'use strict';
const fs = require('node:fs');
const path = require('node:path');

let seqCounter = 0;

// 旧版移入 versions/ 后按 mtime 滚动淘汰,防止事实源被写坏后无法回退。
function rollVersions(filePath, keepVersions) {
  if (!fs.existsSync(filePath) || keepVersions <= 0) return;
  const dir = path.join(path.dirname(filePath), 'versions');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(filePath);
  // 同毫秒多次写用递增计数器产生不同文件名,确保 sort() 能正确淘汰最旧版本。
  fs.copyFileSync(filePath, path.join(dir, `${base}.${Date.now()}.${process.pid}.${String(seqCounter++).padStart(6, '0')}`));
  const mine = fs.readdirSync(dir).filter((f) => f.startsWith(base + '.')).sort();
  for (const f of mine.slice(0, Math.max(0, mine.length - keepVersions))) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
}

function atomicWriteText(filePath, text, { keepVersions = 30 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  rollVersions(filePath, keepVersions);
  const tmp = filePath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);          // rename 前必须 fsync,否则断电后可能是空文件
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function atomicWriteJSON(filePath, obj, opts) {
  atomicWriteText(filePath, JSON.stringify(obj, null, 2) + '\n', opts);
}

module.exports = { atomicWriteText, atomicWriteJSON };
