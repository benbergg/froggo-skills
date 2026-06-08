# 设计文档：vortex-stealth（vortex 电商防风控 playbook）

**Author:** qingwa
**Date:** 2026-06-08
**Status:** 设计已确认，待写实施计划
**目标仓库:** `/Users/lg/workspace/froggo-skills/skills/vortex-stealth/`

---

## 1. 目标与背景

为"大模型通过 vortex MCP 访问京东 / 淘宝 / 天猫"提供一份防风控 playbook。

**核心洞察（来自 vortex dogfood 实战）:** 风控系统不是在检测"爬虫工具"，而是在检测**不像真人的行为**。京东评测中冷跳商品 URL + 高频访问触发了 `pc-frequent-pro.pf.jd.com?reason=403` 封禁，后改用"搜索页进入 + `mouse_drag` 真实点击"的人化路径才绕过。因此本 skill 的灵魂不是一份步骤清单，而是让模型**内化一个因果心智模型**：反人类的操作行为是风控的元凶；模型应能对任意动作自问"真人会这样操作吗？"并据此泛化。

**适用范围:** 只要是大模型驱动访问京东 / 淘宝 / 天猫（浏览、提评价、dogfood、评测、任意自动化访问），就应加载本 skill。不限于评测工作流。

**非目标:**
- 不破解滑块 / 验证码（命中即升级人工）
- 不做指纹伪造 / UA 池 / 代理轮换等"对抗式"规避（与"像真人"原则相悖）
- 不写新代码：纯 playbook，编排现有 vortex MCP 工具调用 + 节奏控制

---

## 2. 形态与文件结构

纯 markdown，**单文件**，零脚本、零外部依赖、零 references。Claude（Claude Code 或 opencode）在用 vortex 访问目标站点时读取并遵循。

```
froggo-skills/skills/vortex-stealth/
└── SKILL.md     # 全部内容：总原则 + 反人类行为对照表 + 进站 SOP + 工具映射表 + 信号识别 + 退避决策树 + 站点附录
```

**单文件原则:** 内容总量精炼，一个 SKILL.md 即可一屏到底读完照做，无需渐进式披露。

**平台不分开:** 京东 / 淘宝 / 天猫的风控判断逻辑本质一致（都在检测"不像真人"），playbook 保持平台无关；站点具体差异（入口 URL、商品卡 selector、403 签名）作为 SKILL.md 末尾的轻量附录段，而非独立平台 playbook。

---

## 3. 触发设计（SKILL.md frontmatter）

```yaml
---
name: vortex-stealth
description: Use when driving vortex MCP to access 京东(JD)/淘宝(Taobao)/天猫(Tmall) —
  browsing, product detail pages, review extraction, dogfood/评测, or any LLM-driven
  automation against these sites. Teaches which operations trigger anti-bot 风控 and
  the human-like alternatives. Triggers: 京东/淘宝/天猫访问、商品详情页、评价提取、
  防风控/反爬/频控、403/滑块/验证码、vortex dogfood、电商人化浏览、anti-detection、stealth browse
---
```

中英混合触发词，覆盖三种调用场景：自然请求（"访问京东商品"）、显式请求（"防风控"）、dogfood/评测工作流。

---

## 4. 核心：反人类行为是风控元凶（SKILL.md 主体）

### 4.1 总原则（开篇）

> 风控系统不是在"检测爬虫工具"，而是在"检测不像真人的行为"。每个动作前先自问：**真人会这样操作吗？** 不会，就是风控信号。

### 4.2 反人类行为对照表（skill 的灵魂）

| 反人类行为（风控元凶） | 为什么是红旗 | 真人替代动作 |
|---|---|---|
| 直接 `navigate` 跳到 `item.jd.com/xxx` / `item.taobao.com/item.htm?id=xxx` 商品详情 URL | 真人从不背商品 URL、冷跳进详情；只有脚本会 | 从搜索/列表页 `mouse_drag` 真实点击进入，走站内 SPA 跳转 |
| 导航后立即连发动作，零停顿 | 真人要看、要读、要想；毫秒级连击只有机器 | 每步 `wait_for {mode:'idle'}` + 随机化停顿 |
| 固定时间间隔的规律性操作 | 真人节奏天然抖动；钟表般规律是脚本指纹 | 停顿时长随机化，动作顺序带人类犹豫 |
| 合成 click 事件（非 `isTrusted`） | 风控读 `event.isTrusted`，合成事件一眼假 | `vortex_mouse_drag` 触发真实鼠标事件 |
| 高频访问同一域、机械翻页 | 真人浏览量有限、会分心、会跳出 | 单会话自我限量，降频，必要时切平台 |
| 频繁清 cookie / 换 UA / 换指纹 | 真人指纹长期稳定；频繁变更=刻意规避 | 复用稳定登录 profile，不动指纹 |
| 风控拦截后立即硬重试 | 真人遇阻会停、会换路；机器才无脑重撞 | 命中 403/滑块即停，走退避决策树 |

每行 = 一个"红旗 → 替代"映射。模型读完应能对**任意**新动作做"像不像真人"判断，而不只是背这 7 条。

### 4.3 四层归纳（对照表的分类，定位为辅）

把上表按层归纳，便于记忆：
- **L1 人化路径与真实交互** — 入口走搜索页、`mouse_drag` 真实点击、站内 SPA 跳转
- **L2 节奏 / 频控节流** — `wait_for idle` + 随机停顿 + 单会话限量
- **L3 会话 / 登录态复用** — 复用稳定登录 profile、开场检测登录态、不动指纹
- **L4 风控检测 + 降级恢复** — `debug_read` 监测信号、命中即停、退避决策树

---

## 5. 进站标准开场流程（把对照表用起来的范例）

```
1. 登录态检测（L3）→ 用 evaluate 读用户名节点 / storage 查 cookie；未登录则升级人工
2. 从搜索页进入（L1）→ navigate s.taobao.com/search?q=<品类> 或 search.jd.com
3. wait_for idle（L2）等页面真稳定
4. observe 拿商品卡 ref → mouse_drag 真实点击进详情（L1）
5. 每步后 debug_read 扫 403/滑块/验证码信号（L4）→ 命中走 §7 退避决策树
6. 详情页数据用 extract / evaluate，动作间随机化停顿（L2）
```

定位：这是对照表的一个应用示例，不是唯一正确流程。模型应以"像不像真人"为准绳灵活变通。

---

## 6. 工具映射表（跨平台中立层）

正文用中立动作描述（"发现可交互元素""监测风控信号"），附表锁到 vortex 工具名。Claude Code 与 opencode 调用同一 vortex MCP server，工具名一致；差异仅在 skill 加载 / 触发机制，故正文保持工具无关、附表负责落地。

| 中立动作 | vortex 工具 |
|---|---|
| 导航 / 进站 | `vortex_navigate` |
| 真实鼠标点击 / 拖拽 | `vortex_mouse_drag` |
| 发现可交互元素 | `vortex_observe` |
| 点击 / 交互 | `vortex_act` |
| 提取文本 / 评价 | `vortex_extract` / `vortex_evaluate` |
| 等页面稳定 | `vortex_wait_for` |
| 监测风控信号 | `vortex_debug_read` |
| 查登录态 / cookie | `vortex_evaluate` / `vortex_storage` |

---

## 7. 信号识别 + 退避 + 站点附录（SKILL.md 末尾段）

直接收进 SKILL.md，全部按"红旗信号 → 替代动作"同构组织：

1. **风控信号识别签名**
   - 403 频控：network 出现 `pc-frequent-pro.pf.jd.com?reason=403` 或同类拦截 URL / 状态码
   - 滑块：滑块验证 DOM 容器出现
   - 验证码：验证码弹层 / 图形验证 DOM 出现
   - 用 `vortex_debug_read`（network + console）捕获

2. **退避决策树**
   - 命中即停（绝不硬重试）→ 暂停 → 降频 / 换品类 → 切平台（京东封切淘宝，实战路径）→ 升级人工

3. **站点差异附录（轻量）**
   - 京东：入口 `search.jd.com`；商品卡 selector `[data-sku]`（非 href）；403 签名 `pc-frequent-pro.pf.jd.com?reason=403`；登录用户名节点
   - 淘宝：入口 `s.taobao.com/search?q=`
   - 天猫：详情 `detail.tmall.com`

---

## 8. 验证方式

纯 playbook 无单测。验证 = **真站 dry-run dogfood**：按进站 SOP 跑一遍京东 + 淘宝商品访问，确认：
- (a) 走"搜索页进入 + `mouse_drag` 真实点击"路径不触发冷跳风控
- (b) 403 / 滑块信号能被 `vortex_debug_read` 捕获并触发退避

与现有 vortex 评测工作流天然衔接。

---

## 9. 跨平台（Claude Code + opencode）兼容

- 两平台都能读 SKILL.md（标准 skill 格式）
- 正文用中立动作描述，工具名集中在映射表，避免平台特定 API 引用
- 两平台用同一 vortex MCP server，`vortex_*` 工具名完全一致；差异仅在加载 / 触发机制，不影响 playbook 内容

---

## 10. 开放项 / 已排除

- ❌ 不做指纹伪造 / 代理池 / UA 轮换（违背"像真人"原则，YAGNI）
- ❌ 不破解滑块 / 验证码（命中升级人工）
- ❌ 不写可执行脚本（纯 playbook 已足够）
