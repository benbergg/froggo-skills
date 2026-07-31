'use strict';

// 固定七段(设计 8.1),故止于「七」;若含伪造的第 8 项,「七」会去找不存在的
// 「## 八、」做右边界,永远解析失败——免责声明段(C12 依赖)因此在真实报告里必挂。
const NUMERALS = ['一', '二', '三', '四', '五', '六', '七'];

// 唯一解析入口:validate 与 render 共用,杜绝「渲染认、自检不认」的错配。
function parseForecast(md) {
  const m = md.match(/```json\s*([\s\S]*?)```/);
  let json = null;
  if (m) { try { json = JSON.parse(m[1]); } catch { json = null; } }

  const sections = {};
  const headings = {};
  for (let i = 0; i < NUMERALS.length; i++) {
    const cur = NUMERALS[i];
    const next = NUMERALS[i + 1];
    // `##` 可选:实测 M3 时而写「## 一、xxx」时而写裸「一、xxx」(总标题却带 ##),
    // 赌它每次记得打 # 的代价是七段全判缺失、三轮空转后降级。裸标题限 40 字,
    // 否则正文里一句「一、……」的枚举会抢走段边界,把第一段截成空壳。
    const head = `^(?:#{1,3}\\s*${cur}、([^\\n]*)|${cur}、([^\\n]{0,40}))\\n`;
    const re = next
      ? new RegExp(`${head}([\\s\\S]*?)(?=^(?:#{1,3}\\s*${next}、|${next}、))`, 'm')
      : new RegExp(`${head}([\\s\\S]*)$`, 'm');
    const hit = md.match(re);
    if (hit) { headings[cur] = (hit[1] ?? hit[2] ?? '').trim(); sections[cur] = hit[3].trim(); }
  }
  return { json, sections, headings, raw: md };
}

module.exports = { parseForecast, NUMERALS };
