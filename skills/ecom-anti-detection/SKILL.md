---
name: ecom-anti-detection
description: Use when an LLM drives browser automation to access 京东(JD)/淘宝(Taobao)/天猫(Tmall) — browsing, product detail pages, review extraction, dogfood/评测, or any automated access. Teaches which operations trigger anti-bot 风控 and how to browse like a real human. Tool-agnostic (works with vortex, playwright, etc). Triggers 京东/淘宝/天猫访问、商品详情页、评价提取、防风控/反爬/频控、403/滑块/验证码、电商人化浏览、anti-detection、stealth browse
---

# ecom-anti-detection — 电商防风控 playbook

## 核心原则

> **风控系统不是在检测"爬虫工具"，而是在检测"不像真人的行为"。**
> 每个动作前先自问：**真人会这样操作吗？** 不会，就是风控信号。
>
> 换个问法：不要问"怎么最快完成任务"，要问"一个真人为了这个目的会怎么逛"——然后照那个人的样子操作。

## 何时用

只要是大模型驱动浏览器自动化访问京东 / 淘宝 / 天猫——浏览、进商品详情、提评价、dogfood、评测、任意自动化访问——就加载本 skill。**工具无关**：把正文的中立动作映射到你手头工具的对应能力即可（vortex / playwright / 等）。不限于评测工作流。

## 何时不用

- 非这三个站点的普通网页自动化
- 需要破解滑块 / 验证码（本 skill 命中即升级人工，不破解）
- 想做指纹伪造 / UA 池 / 代理轮换（与"像真人"原则相悖，本 skill 不做）
