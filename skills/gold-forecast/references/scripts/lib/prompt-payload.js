'use strict';
// 不变量:**进 prompt 的每个数字都必须能被 C4 引用**。
//
// 保证它的唯一可靠方式是让「送进 prompt 的对象」与「C4 的允许池」出自同一个投影。
// 两处各写一份必然漂移:顶层 data_quality 就是这么漏出去的 —— build-prompt 把整个
// scorecard 塞进不可截断的 calibration 块,而 C4 的池只取 by_horizon,于是那些数字
// 模型看得见、一引用就 block,三轮修复全废。
//
// 漂移的另一半更隐蔽:C4 的池窄于 prompt 时,**设计要求写的内容会变成写不出来**。
// 设计 8.1 规定第五段必须呈现「覆盖率与 abandoned 计数」,而它们在 scorecard.coverage
// 里 —— 旧池不含 coverage,等于自检在阻止报告满足设计。故本次按不变量把池放宽到
// 整个 payload,而不是逐个字段补。
//
// 反方向同样是不变量的一部分:**不想被引用的数字就不要送进 prompt**。
// data_quality 是运维诊断(被剔除的非有限值计数),模型本就不该在公开报告里引用
// 剔除计数,所以它从 payload 里剥掉 —— 剥掉之后它自然也不在池里,两边仍然一致。

const OPS_ONLY_SCORECARD_KEYS = ['data_quality'];

function promptScorecard(scorecard) {
  if (!scorecard || typeof scorecard !== 'object' || Array.isArray(scorecard)) return scorecard;
  const out = { ...scorecard };
  for (const k of OPS_ONLY_SCORECARD_KEYS) delete out[k];
  return out;
}

// facts 与 baseline 整体进 prompt、整体可引用,不做裁剪 —— 它们本就是给模型用的输入。
function promptPayload({ facts, baseline, scorecard }) {
  return { facts, baseline, scorecard: promptScorecard(scorecard) };
}

module.exports = { promptPayload, promptScorecard, OPS_ONLY_SCORECARD_KEYS };
