---
name: refund-insight
description: "抖音退款原因分析报告生成。从班牛售后明细 xlsx 重组为分析就绪数据(双层归因/三级样本/静默画像),按口径硬规则生成麦肯锡风格交互式 HTML 报告。内置数据陷阱处理:订单号 float 失真→工单号锚定、退款率用汇总口径、情绪率剔除缺失分母、可分析样本(进线≥1且定位原因)为各原因占比分母。触发词:退款分析、退款原因分析、退款报告、退款洞察、售后分析、退款数据、班牛退款报告、refund insight。"
---

# 抖音退款原因分析报告生成

> **核心理念**(与 [`weekly-report`](../weekly-report/SKILL.md) / [`exp-compass-daily`](../exp-compass-daily/SKILL.md) 一致):Python 脚本只做"明细 xlsx → 分析就绪数据"的确定性转换 + 断言自检;AI 看完整数据按模板/口径写 HTML 报告;人工预览确认。
> 判断力沉淀(数据陷阱、口径裁定、方法论)见 [`references/methodology.md`](references/methodology.md)——**动手前必读**。

## When to Use

触发关键词:**退款分析、退款原因分析、退款报告、退款洞察、售后分析、退款数据、班牛退款报告、refund insight**。

适用:拿到班牛抖音售后导出的退款明细 xlsx,要产出给客户(电商总经理/客服负责人)的退款原因分析与改善提案报告。

## 输入要求

| 输入 | 必需 | 说明 |
|---|---|---|
| 退款明细 xlsx | ✓ | 班牛工单系统导出,Sheet1,列结构见 [`methodology.md`](references/methodology.md) §一 |
| 汇总 JSON | – | `{"品牌短名":{"orders":订单总数,"refund_orders":平台售后单数},...}`,用于**退款率口径**;缺省用欧莱雅样例值(换客户务必提供,否则退款率不对) |
| 客户/品牌英文名 | – | 抓客户 logo 用(Wikimedia) |

## 主流程(Step 0–5)

### Step 0 准备
- 确认明细 xlsx 路径;若新客户,准备 `summary.json`(汇总订单数/售后单数)。
- 设工作目录(放产物),如客户项目目录。

### Step 1 数据层重组(确定性,跑脚本)

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/skills/refund-insight/references/scripts/refund_data_layer.py \
  <退款明细.xlsx> [summary.json] [输出目录]
# 例: python3 .../refund_data_layer.py 客户退款.xlsx summary.json ./output
```
产出到输出目录:
- `分析结果.md` —— 产物 B–F 全部表格(双层归因/静默画像/明确诉求/三级样本/口径附件),**喂给 AI 写报告的唯一数据源**
- `分析就绪明细.csv` —— 产物 A(含派生列,订单号已标记不可靠)
- `异常行清单.csv`

### Step 2 数据自检(必须)

```bash
# 黄金回归(仅对欧莱雅样例,含特定数值断言;skill 开发/回归用):
REFUND_XLSX=/path/欧莱雅...xlsx PYTHONPATH=${CLAUDE_PLUGIN_ROOT}/skills/refund-insight/references/scripts \
  python3 ${CLAUDE_PLUGIN_ROOT}/skills/refund-insight/tests/checks.py
```
**新客户数据**不跑黄金回归(数值断言会失败属预期),改做结构自检:`分析结果.md` 行数合理、品牌集合正确、退款率落在 (0,1)、可分析样本为各原因占比分母、案例带工单编号与分析依据。

### Step 3 抓 Logo

```bash
bash ${CLAUDE_PLUGIN_ROOT}/skills/refund-insight/references/assets/fetch-logos.sh \
  <输出目录>/report/assets <客户品牌英文名>
```
失败则封面改用高质感文字字标(不阻塞)。**注意:抖音系国货/专业线品牌(如修丽可 SkinCeuticals、卡诗 Kérastase)常在 Wikimedia 无品牌图片,下载失败属正常,直接用文字字标即可,不必纠结。**班牛 logo 直达 URL 一般可下。

### Step 4 AI 生成分品牌 HTML 报告

**品牌独立**(同集团多品牌不互比)。每个品牌一份独立 HTML,可并行(每品牌派一个 subagent)。

1. `Read` 输出目录的 `分析结果.md`(取该品牌节 + 集团表 + 口径附件)。该品牌节已含**所有图表数据**:三级样本、静默画像、每日退款趋势、各退款类型情绪分布、可分析实情 Top、明确诉求、双层归因交叉表、典型案例(带分析依据)。
2. 以 [`references/report-template.html`](references/report-template.html)(兰蔻 v1.1)为**结构/设计模板**,替换为目标品牌数据。模板里的每日趋势/退款类型情绪两张图,数据取该品牌节对应表,**不要照搬兰蔻数值**。
3. 严格遵循 § 报告硬规则 与 [`report-spec.md`](references/report-spec.md)(完整 prompt 规格)。
4. 输出 `<输出目录>/report/{品牌}退款原因分析-v1-{YYYYMMDD}.html`,**每品牌独立版本序列**。

### Step 5 人工预览确认
起本地 server 截图核对(见 § 验证),确认视觉/数字/交互后交付。

---

## 报告硬规则(撰写时严格遵守,详见 methodology.md)

1. **退款率用汇总口径**(汇总售后单数 ÷ 订单总数),**禁**用明细记录数当分子;同时标注"明细覆盖率"。
2. **负面情绪率以"有情绪记录"为分母**(剔除缺失),禁止把约半数缺失计入分母稀释。
3. **各原因占比以"可分析样本"为分母**(进线≥1 且 定位原因),非全样本。
4. **核实锚点用工单编号**(订单号 float 失真不可用),报告声明此事。
5. **典型案例**按情绪烈度(🔴优先)选 2–3 条,每条含 工单编号+商品名+SKU+买家原声+**分析依据**(因果推理)。
6. **三级样本**(全量>可分析>可归因)显式呈现。
7. **双层归因热力图**(顾客声明原因 × AI 聊天实情)必出——这是核心洞察。
8. **显著性标注**(默认阈值,以数据层 `sig_note` 为准):n≥30 正常出结论、10≤n<30 标"仅供参考"、n<10 不下结论。模板里若出现 n≥50 等其它阈值,是兰蔻该报告的个别选择,**新报告统一用 n≥30**。
9. **数字精确**,不臆造;预估仅用于未来收益测算。
9.5 **班牛提案必须过合规护栏**(见 methodology.md §九):剔除"AI 主动触达维挽/价保自动退差"等踩红线或第三方做不到的措施;主推抖店开放 API 支持的售后自动化(退款/售后审批、物流拦截、改地址、换货)+ 引导消费者自助申请价保 + 合规通知卡片。退款率按日历口径并声明局限(见 §十)。
10. **设计**:Swiss Modern + Deep Navy & Teal、PingFang 字体(禁宋体)、数字右对齐、Chartjunk Removal、PPT 页面风格(封面/底页/口径附件)、标题即结论(业务语言)、折叠展开金字塔下钻(结论→分项→证据)。

## 验证(Step 5)

```bash
cd <输出目录>/report && python3 -m http.server 8899 &
# 浏览器/Playwright 打开 http://localhost:8899/<报告文件>,核对:
# 无 JS 报错、图表渲染、折叠展开可用、关键数字与分析结果.md 一致、封面 logo/字体/右对齐
```

## 异常处理

| 异常 | 处理 |
|---|---|
| xlsx 列名不符 | 对照 methodology.md §一;非班牛标准导出需先转列名 |
| 新客户退款率明显偏低(如<20%) | 多半漏了 summary.json → 用了明细记录数当分子;补汇总数据重跑 |
| 品牌自动推断出"未知"或拆分不对 | 在脚本 `BRAND_CONFIG` 登记精确映射 |
| logo 下载失败 | 封面改文字字标,不阻塞 |
| 某原因 n 很小 | 按显著性标注规则,不强行下结论 |
| to_markdown 报缺 tabulate | `pip3 install tabulate` |

## 渐进式深读

| 何时读 | 文件 |
|---|---|
| 动手前(数据陷阱/口径/方法论) | [`references/methodology.md`](references/methodology.md) |
| 报告完整规格(配色/版式/提案要求) | [`references/report-spec.md`](references/report-spec.md) |
| HTML 结构/图表/折叠交互参照 | [`references/report-template.html`](references/report-template.html) |
| 改数据层逻辑/新增指标 | [`references/scripts/refund_data_layer.py`](references/scripts/refund_data_layer.py) |
| 断言契约 | [`tests/checks.py`](tests/checks.py) |

## 硬约束

- **本机产出先落输出目录**,人工确认再交付客户。
- **数字必出自 `分析结果.md`**(脚本是 ground truth),严禁 AI 自己重数。
- **品牌分开独立分析**,同集团多品牌不互相比较。
- 中文文案;禁止任何署名(Created by / @author 等)。
