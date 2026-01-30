---
name: codex-reviewer
description: >
  Codex 深度代码审查 - 当需要以下能力时使用此 Skill：

  **明确优势场景（优先使用）：**
  - 安全漏洞检测（88% LiveCodeBench 准确率）
  - Bug 和逻辑错误深度识别
  - UI/前端代码审查（一次成功率高）
  - 交叉验证 Claude 审查结果（第二意见）

  **关键词触发：**
  codex review, codex 审查, 深度审查, 安全审计,
  漏洞扫描, bug 检测, 交叉验证, 多模型审查,
  第二意见, Codex 代码审查, 安全检测, 深度扫描

  **与 superpowers:code-reviewer 的区别：**
  superpowers 使用 Claude 自身审查（上下文理解强），
  codex-reviewer 使用 OpenAI Codex 审查（缺陷检测准）。
  两者可组合使用进行交叉验证。
---

# Codex Code Reviewer

## Overview

使用 OpenAI Codex SDK 对代码进行深度审查。Codex 在以下领域有明确优势：
- **缺陷检测**：88% LiveCodeBench 准确率
- **安全审计**：深入识别安全漏洞
- **UI 代码**：一次成功率更高

## When to Use

**自动触发场景：**
- 用户明确要求使用 Codex 审查
- 需要安全审计或漏洞扫描
- 需要交叉验证 Claude 审查结果
- UI/前端代码审查

**与 superpowers 协作：**
- 常规审查用 superpowers:code-reviewer
- 安全敏感代码用 codex-reviewer
- 重要变更两者都用，交叉验证

## 前置条件

Codex SDK 支持多种认证方式：

**方式 1：ChatGPT 订阅用户（推荐）**
```bash
# 首次使用需要登录
codex login
```
登录后自动使用 ChatGPT 账户凭据，无需额外配置。

**方式 2：API Key 用户**
```bash
export OPENAI_API_KEY="sk-..."
```

## 执行流程

**Step 1: 获取待审查代码**

获取 git diff 内容：
!`git diff --staged --no-color 2>/dev/null || git diff HEAD~1 --no-color 2>/dev/null || echo ""`

**Step 2: 执行 Codex 审查**

将 diff 内容传递给审查脚本：
!`git diff --staged --no-color 2>/dev/null || git diff HEAD~1 --no-color | node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-reviewer/index.js`

**Step 3: 解析并展示结果**

根据脚本输出的 JSON，按以下格式展示审查结果：

### 🔴 Critical（必须修复）

列出所有 critical 级别的问题：
- **文件:行号** - 问题描述
  > 建议修复方案

### 🟡 Warning（建议修复）

列出所有 warning 级别的问题：
- **文件:行号** - 问题描述
  > 建议修复方案

### 🔵 Info（改进建议）

列出所有 info 级别的建议：
- **文件:行号** - 建议描述
  > 改进方案

### 📊 审查摘要

显示 summary 字段内容，以及各级别问题统计。

## 错误处理

如果脚本返回 error: true，根据 message 提示用户：
- "Codex API 调用失败" → 建议运行 `codex login` 登录或检查网络

## 使用示例

```
用户: 用 Codex 审查一下我的代码
用户: 做个深度安全审计
用户: 给个第二意见，交叉验证一下
用户: /codex-review
```
