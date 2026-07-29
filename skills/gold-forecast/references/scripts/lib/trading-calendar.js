'use strict';

function isSession(calendar, date) {
  return calendar.includes(date);
}

// 返回 fromDate 之后第 n 个交易日。fromDate 本身不计入,
// 不在日历内时从其后第一个交易日开始数。
function nthSession(calendar, fromDate, n) {
  // 先把 fromDate 贴到日历上:在日历内用自身,否则用其后第一个交易日。
  const anchor = calendar.includes(fromDate) ? fromDate : calendar.find((d) => d > fromDate);
  if (anchor === undefined) return null;
  const after = calendar.filter((d) => d > anchor);
  return after.length >= n ? after[n - 1] : null;
}

function sessionsBetween(calendar, a, b) {
  return calendar.filter((d) => d > a && d <= b).length;
}

module.exports = { isSession, nthSession, sessionsBetween };
