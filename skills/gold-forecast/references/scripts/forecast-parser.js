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
    const re = next
      ? new RegExp(`^##\\s*${cur}、([^\\n]*)\\n([\\s\\S]*?)(?=^##\\s*${next}、)`, 'm')
      : new RegExp(`^##\\s*${cur}、([^\\n]*)\\n([\\s\\S]*)$`, 'm');
    const hit = md.match(re);
    if (hit) { headings[cur] = hit[1].trim(); sections[cur] = hit[2].trim(); }
  }
  return { json, sections, headings, raw: md };
}

module.exports = { parseForecast, NUMERALS };
