---
name: grill-me
description: "Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree one question at a time. Use when the user wants to stress-test a plan, get grilled on a design, or pressure-test architecture decisions. 拷问我、逼问、压力测试方案、质询设计、逐条审问、grill me、stress test、把计划逼到墙角、方案评审、设计评审、拷问式提问"
---

# 拷问式方案评审（Grill Me）

## Overview

本技能把对话切换成「审讯式」评审：针对用户给出的计划或设计**逐个分支地无情拷问**，直到双方对每个决策达成共识。它是 `superpowers:brainstorming` 的收敛侧补充——brainstorming 负责发散探索意图，grill-me 负责把已成形的方案逼到墙角、暴露漏洞与隐含依赖。

## When to Use

- 用户已有计划/设计草案，想被「拷问」以找出漏洞
- 用户说「拷问我 / 逼问我 / 压力测试这个方案 / grill me / stress-test this plan」
- 准备进入 writing-plans 前，想先把架构决策逐条质询清楚

## 规则

1. **一次只问一个问题**，等用户回答后再问下一个。不要一次抛出问题清单。
2. **每个问题都附上你的推荐答案**，并简述理由——让用户在「确认 / 推翻」中前进，而非从零作答。
3. **遍历决策树的每个分支**，逐一解决决策之间的依赖关系：先问会影响后续分支的根决策。
4. **能从代码库找到答案的，自己去查，不要问用户**。探索代码后把结论作为已确认前提带入后续提问。
5. 目标是**达成共享理解**——当所有分支都被解决、没有悬而未决的依赖时，收束并复述最终共识。

## 与 brainstorming 的边界

| | brainstorming | grill-me |
|---|---|---|
| 方向 | 发散：探索意图、需求、可能性 | 收敛：拷问、压力测试既定方案 |
| 时机 | 还没想清楚要做什么 | 已有草案，想找漏洞 |
| 形式 | 开放探讨 | 一次一问 + 每问带推荐答案 |
