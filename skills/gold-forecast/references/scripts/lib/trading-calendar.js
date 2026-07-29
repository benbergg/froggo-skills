'use strict';

// 当前全仓库零调用者(已复核两次)。也不能用于 target_date 外推——
// 生产里 calendar_tail 全是过去的定盘日、末元素就是 today,filter(d > anchor) 恒空。
// 保留是因为它是唯一一处对「交易日历」概念的正确实现,后续若要做 T+N 外推
// 需要先解决 calendar 本身缺未来交易日的问题,而不是重新发明这几个函数。

function isSession(calendar, date) {
  return calendar.includes(date);
}

// 返回 fromDate 之后第 n 个交易日。fromDate 本身不计入,
// 不在日历内时从其后第一个交易日开始数。
function nthSession(calendar, fromDate, n) {
  // n<=0 语义上不存在"第 n 个之后的交易日";不挡会让 after[-1] 取到 undefined,
  // JSON.stringify 静默丢字段,比抛错更难排查——按 string|null 契约收敛成 null。
  if (!(n > 0)) return null;
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
