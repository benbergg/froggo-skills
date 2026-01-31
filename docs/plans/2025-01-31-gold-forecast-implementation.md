# Gold Forecast Skill 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 创建黄金行情预测 Skill，提供技术面+基本面+博弈面三维分析仪表盘

**Architecture:** 纯 Claude + MCP 方案。使用 WebFetch 获取 API 数据，MCP Playwright 抓取财经网站，Claude 直接进行分析和评分计算。

**Tech Stack:** Markdown Skill 规范、MCP Playwright、WebFetch API

**Design Doc:** `docs/plans/2025-01-31-gold-forecast-design.md`

---

## Task 1: 创建 SKILL.md 技能规范文件

**Files:**
- Create: `skills/gold-forecast/SKILL.md`

**Step 1: 创建目录**

```bash
mkdir -p skills/gold-forecast
```

**Step 2: 创建 SKILL.md 文件**

```markdown
---
name: gold-forecast
description: >
  黄金行情预测与投资建议 - 当需要以下能力时使用此 Skill：

  **触发场景：**
  - 查询黄金行情、金价走势
  - 获取黄金投资建议
  - 分析黄金市场多空博弈

  **关键词触发：**
  gold forecast, 黄金预测, 金价分析, 黄金行情,
  黄金投资, 买黄金, 卖黄金, 金价走势, 黄金ETF,
  伦敦金, 上海金, XAU, 贵金属, 避险资产
---

# Gold Forecast - 黄金行情预测

## Overview

多维度黄金行情分析工具，整合技术面、基本面、博弈面数据，输出结构化仪表盘和投资建议。

**必须显示提示：** 使用此 Skill 时，必须在开始时输出：
> 🥇 **正在获取黄金行情数据...**
> 数据来源：国际金价 API、新浪财经、东方财富、金十数据

## When to Use

**自动触发场景：**
- 用户询问黄金价格、走势
- 用户询问是否应该买入/卖出黄金
- 用户询问黄金 ETF 投资
- 用户询问避险资产配置

## 执行流程

### Phase 1: 数据获取

**并行获取以下数据：**

#### 1.1 国际金价 (WebFetch)

尝试以下 API（按优先级）：

```
# 优先：metals.live（免费无需 key）
https://api.metals.live/v1/spot/gold

# 备用：金价 API
https://api.gold-price.org/spot
```

获取字段：
- 当前价格 (USD)
- 24h 涨跌
- 24h 涨跌幅

#### 1.2 美元指数 (Playwright)

```
目标：新浪财经美元指数页面
URL: https://finance.sina.com.cn/money/forex/hq/DINIW.shtml
抓取：当前点位、涨跌幅
```

#### 1.3 国内金价 (Playwright)

```
目标：新浪财经黄金行情
URL: https://finance.sina.com.cn/futuremarket/
抓取：Au99.99 价格、涨跌
```

#### 1.4 黄金 ETF (Playwright)

```
目标：东方财富 ETF 行情
华安黄金 ETF: http://quote.eastmoney.com/sz518880.html
抓取：最新价、涨跌幅、成交额
```

#### 1.5 市场数据 (WebFetch/Playwright)

```
# SPDR ETF 持仓
https://www.spdrgoldshares.com/

# 金十数据（CFTC 持仓、要闻）
https://www.jin10.com/
```

### Phase 2: 多维分析

#### 2.1 技术面分析 (权重 30%)

| 指标 | 计算方法 | 评分规则 |
|------|---------|---------|
| 趋势方向 | 当前价 vs 5日/20日均价 | 多头排列 +30，空头 -30，震荡 0 |
| 支撑阻力 | 整数关口±1% | 接近支撑 +20，接近阻力 -20 |
| 动量 | 近 5 日涨跌幅 | >3% +25, 1-3% +15, -1~1% 0, <-3% -25 |
| 波动率 | 近 5 日振幅 | 低波动 +10，高波动 -10 |

技术面评分 = 各指标得分汇总，归一化到 0-100

#### 2.2 基本面分析 (权重 40%)

| 因素 | 评判标准 | 评分规则 |
|------|---------|---------|
| 美元指数 | DXY 点位和趋势 | <100 +25, 100-103 0, >103 -25 |
| 美联储政策 | 降息/加息预期 | 降息预期 +30，加息预期 -30 |
| 通胀数据 | CPI 趋势 | 高通胀 +20，低通胀 -10 |
| 地缘政治 | 风险事件 | 有重大事件 +25 |

基本面评分 = 各因素得分汇总，归一化到 0-100

#### 2.3 博弈面分析 (权重 30%)

| 指标 | 数据来源 | 评分规则 |
|------|---------|---------|
| ETF 持仓 | SPDR GLD | 周增持 +25，周减持 -25 |
| CFTC 净多头 | 金十数据 | 极端高位 -20，极端低位 +20 |
| 央行购金 | 世界黄金协会 | 持续增持 +15 |
| 多空比例 | 期货市场 | 散户极端看多 -15（反向） |

博弈面评分 = 各指标得分汇总，归一化到 0-100

#### 2.4 综合评分

```
综合评分 = 技术面 × 0.3 + 基本面 × 0.4 + 博弈面 × 0.3

评分区间：
  80-100: 强烈看多 🟢🟢
  60-79:  谨慎看多 🟢
  40-59:  中性观望 🟡
  20-39:  谨慎看空 🔴
  0-19:   强烈看空 🔴🔴
```

### Phase 3: 仪表盘输出

**输出格式模板：**

```
╔══════════════════════════════════════════════════════════════╗
║                 🥇 黄金行情分析仪表盘                          ║
║                   {日期} {时间} CST                           ║
╠══════════════════════════════════════════════════════════════╣
║  📊 实时行情                                                  ║
║  ┌────────────────┬────────────┬────────────┬─────────────┐  ║
║  │     品种       │    价格    │    涨跌    │   涨跌幅    │  ║
║  ├────────────────┼────────────┼────────────┼─────────────┤  ║
║  │  伦敦金 XAU    │  ${价格}   │   {涨跌}   │   {幅度}%   │  ║
║  │  上海金 Au99   │  ¥{价格}   │   {涨跌}   │   {幅度}%   │  ║
║  │  华安黄金 ETF  │  ¥{价格}   │   {涨跌}   │   {幅度}%   │  ║
║  └────────────────┴────────────┴────────────┴─────────────┘  ║
╠══════════════════════════════════════════════════════════════╣
║  📈 多维评分                                                  ║
║                                                              ║
║  技术面 [{进度条}] {分数}/100   {简评}                        ║
║  基本面 [{进度条}] {分数}/100   {简评}                        ║
║  博弈面 [{进度条}] {分数}/100   {简评}                        ║
║  ─────────────────────────────────────────                   ║
║  综合评分 [{进度条}] {分数}/100                               ║
╠══════════════════════════════════════════════════════════════╣
║  💡 操作建议                                                  ║
║                                                              ║
║  建议：{建议} {emoji}                                         ║
║                                                              ║
║  • 短期：{短期建议}                                           ║
║  • 中期：{中期建议}                                           ║
║  • 风险：{风险提示}                                           ║
╠══════════════════════════════════════════════════════════════╣
║  📰 关键要闻                                                  ║
║  • {要闻1}                                                    ║
║  • {要闻2}                                                    ║
║  • {要闻3}                                                    ║
╚══════════════════════════════════════════════════════════════╝
```

**进度条生成规则：**
- 每 10 分一个 █
- 剩余用 ░ 填充
- 示例：72 分 → `████████░░`

## 数据源配置

### 免费 API

| 名称 | URL | 说明 |
|------|-----|------|
| Metals.live | `https://api.metals.live/v1/spot/gold` | 实时金价，无需 key |
| 汇率 API | `https://api.exchangerate-api.com/v4/latest/USD` | 美元汇率 |

### 抓取目标

| 数据 | 网站 | URL |
|------|------|-----|
| 美元指数 | 新浪财经 | `https://finance.sina.com.cn/money/forex/hq/DINIW.shtml` |
| 国内金价 | 新浪财经 | `https://finance.sina.com.cn/futures/quotes/AU0.shtml` |
| 黄金 ETF | 东方财富 | `http://quote.eastmoney.com/sz518880.html` |
| 财经要闻 | 金十数据 | `https://www.jin10.com/` |

## 容错处理

1. **单数据源失败**：标注"数据获取失败"，不影响其他分析
2. **API 限流**：使用备用数据源或缓存数据
3. **网页结构变化**：提示用户数据可能不准确

## 示例输出

当用户询问"黄金现在能买吗"时，执行完整流程并输出仪表盘。

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 只看单一指标 | 综合三维分析 |
| 忽略数据时效 | 标注数据获取时间 |
| 给出绝对建议 | 强调仅供参考 |
| 忽略风险提示 | 每次都包含风险因素 |
```

**Step 3: 验证文件创建成功**

```bash
cat skills/gold-forecast/SKILL.md | head -20
```

**Step 4: Commit**

```bash
git add skills/gold-forecast/SKILL.md
git commit -m "feat: 添加 gold-forecast skill 规范 #0000"
```

---

## Task 2: 创建命令入口文件

**Files:**
- Create: `commands/gold-forecast.md`

**Step 1: 创建命令文件**

```markdown
---
name: gold-forecast
description: "查看黄金行情分析和投资建议"
skill: gold-forecast
---

# /gold-forecast 命令

获取黄金行情多维分析仪表盘，包含技术面、基本面、博弈面综合评分和操作建议。

## 用法

```
/gold-forecast
```

## 分析维度

- **技术面 (30%)**：价格趋势、支撑阻力、动量指标
- **基本面 (40%)**：美元指数、美联储政策、通胀、地缘政治
- **博弈面 (30%)**：ETF持仓、CFTC持仓、央行购金、多空比例

## 数据来源

- 国际金价：Metals.live API
- 国内金价：新浪财经
- 黄金 ETF：东方财富
- 市场要闻：金十数据

## 示例

```
/gold-forecast

→ 输出黄金行情分析仪表盘，包含：
  - 三大品种实时行情（伦敦金、上海金、黄金ETF）
  - 技术面/基本面/博弈面三维评分
  - 综合操作建议（短期/中期/风险提示）
  - 近期关键财经要闻
```

---

**执行**：调用 `gold-forecast` skill 处理
```

**Step 2: 验证文件创建成功**

```bash
cat commands/gold-forecast.md
```

**Step 3: Commit**

```bash
git add commands/gold-forecast.md
git commit -m "feat: 添加 /gold-forecast 命令入口 #0000"
```

---

## Task 3: 功能测试

**Step 1: 安装插件到 Claude Code**

```bash
# 在 Claude Code 中执行
/plugin install /Users/lg/workspace/froggo-skills
```

**Step 2: 测试命令可用性**

```
# 在 Claude Code 中执行
/gold-forecast
```

**Step 3: 验证输出**

检查是否：
- [ ] 正确获取国际金价数据
- [ ] 正确获取国内金价数据
- [ ] 正确获取 ETF 数据
- [ ] 输出仪表盘格式正确
- [ ] 三维评分计算合理
- [ ] 操作建议逻辑正确

**Step 4: 记录测试结果**

如有问题，返回 Task 1 或 Task 2 调整 SKILL.md 内容。

---

## Task 4: 版本更新与最终提交

**Files:**
- Modify: `.claude-plugin/plugin.json`

**Step 1: 更新版本号**

将 `version` 从 `1.15.0` 更新为 `1.16.0`

**Step 2: Commit**

```bash
git add .claude-plugin/plugin.json
git commit -m "chore: 升级版本号至 1.16.0，新增 gold-forecast skill #0000"
```

**Step 3: 推送到远程（可选）**

```bash
git push origin master
```

---

## 完成检查清单

- [ ] `skills/gold-forecast/SKILL.md` 创建完成
- [ ] `commands/gold-forecast.md` 创建完成
- [ ] 插件安装测试通过
- [ ] `/gold-forecast` 命令可正常执行
- [ ] 仪表盘输出格式正确
- [ ] 版本号已更新
- [ ] 所有变更已提交
