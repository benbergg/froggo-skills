'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
  // 固定 tmp 名在并发写下会被另一进程的 open(O_TRUNC) 截断/借壳,
  // 实测出现「破坏发生在对方 rename 之后」——已提交的文件被污染而不是常见的半截文件模式。
  // pid+时间戳+进程内计数器+随机数四重保证同名概率归零。
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${String(seqCounter++).padStart(6, '0')}.${crypto.randomBytes(4).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx'); // wx 而非 w:目标已存在就报错,不做静默截断
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);          // rename 前必须 fsync,否则断电后可能是空文件
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已损坏的 fd,忽略二次错误 */ } }
    try { fs.rmSync(tmp, { force: true }); } catch { /* tmp 可能从未创建成功 */ }
    throw e;
  }
}

function atomicWriteJSON(filePath, obj, opts) {
  atomicWriteText(filePath, JSON.stringify(obj, null, 2) + '\n', opts);
}

module.exports = { atomicWriteText, atomicWriteJSON };
