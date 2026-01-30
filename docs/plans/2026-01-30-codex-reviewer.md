# codex-reviewer Skill 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 codex-reviewer Skill，使用 OpenAI Codex SDK 进行深度代码审查。

**Architecture:** 通过 Command 触发 Skill，Skill 执行 Node.js 脚本调用 Codex SDK，返回结构化审查结果（Critical/Warning/Info）。通过 description 关键词与 superpowers:code-reviewer 协作。

**Tech Stack:** Node.js 18+, @openai/codex-sdk, Claude Code Plugin System

**设计文档:** [[20260130-01-codex-reviewer-skill设计]]

---

## Task 1: 创建脚本目录结构

**Files:**
- Create: `scripts/codex-reviewer/package.json`
- Create: `scripts/codex-reviewer/.env.example`

**Step 1: 创建 package.json**

```json
{
  "name": "codex-reviewer",
  "version": "1.0.0",
  "description": "Codex SDK code reviewer for Claude Code",
  "type": "module",
  "main": "index.js",
  "scripts": {
    "review": "node index.js"
  },
  "dependencies": {
    "@openai/codex-sdk": "^0.87.0"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

**Step 2: 创建 .env.example**

```bash
# 必需：OpenAI API Key
OPENAI_API_KEY=sk-your-api-key-here

# 可选：Codex 模型（默认使用 SDK 默认值）
# CODEX_MODEL=gpt-5.2-codex

# 可选：超时时间（毫秒，默认 60000）
# CODEX_TIMEOUT=60000
```

**Step 3: 验证目录结构**

Run: `ls -la scripts/codex-reviewer/`
Expected: 显示 package.json 和 .env.example

**Step 4: Commit**

```bash
git add scripts/codex-reviewer/
git commit -m "chore: 初始化 codex-reviewer 脚本目录结构 #0000"
```

---

## Task 2: 实现 Node.js 主脚本

**Files:**
- Create: `scripts/codex-reviewer/index.js`

**Step 1: 创建主脚本**

```javascript
#!/usr/bin/env node
/**
 * Codex Code Reviewer
 * 使用 OpenAI Codex SDK 进行深度代码审查
 */

import { Codex } from "@openai/codex-sdk";

const REVIEW_PROMPT = `You are a senior code reviewer with expertise in security, performance, and code quality.

Analyze the following code changes and identify issues in these categories:

1. **Critical** - Must fix before merge:
   - Security vulnerabilities (SQL injection, XSS, etc.)
   - Data loss risks
   - Breaking changes without migration
   - Bugs that cause crashes or incorrect behavior

2. **Warning** - Should fix:
   - Missing error handling
   - Potential null/undefined issues
   - Logic errors in edge cases
   - Missing input validation

3. **Info** - Nice to have:
   - Code style improvements
   - Performance optimizations
   - Documentation suggestions
   - Refactoring opportunities

Output format (JSON only, no markdown):
{
  "critical": [
    { "file": "path/to/file.js", "line": 45, "issue": "SQL injection vulnerability", "suggestion": "Use parameterized query" }
  ],
  "warning": [
    { "file": "path/to/file.js", "line": 23, "issue": "Missing null check", "suggestion": "Add null check before accessing property" }
  ],
  "info": [
    { "file": "path/to/file.js", "line": 10, "issue": "Magic number", "suggestion": "Extract to named constant" }
  ],
  "summary": "Brief overall assessment"
}

Code to review:
`;

async function main() {
  // 检查 API Key
  if (!process.env.OPENAI_API_KEY) {
    console.error(JSON.stringify({
      error: true,
      message: "OPENAI_API_KEY 环境变量未设置。请设置后重试。"
    }));
    process.exit(1);
  }

  // 读取 stdin（git diff 输出）
  const diff = await readStdin();

  if (!diff.trim()) {
    console.log(JSON.stringify({
      critical: [],
      warning: [],
      info: [],
      summary: "没有待审查的代码变更"
    }));
    return;
  }

  try {
    const codex = new Codex();
    const thread = codex.startThread({
      workingDirectory: process.cwd()
    });

    const turn = await thread.run(REVIEW_PROMPT + diff);

    // 尝试解析 JSON，如果失败则包装原始响应
    try {
      const result = JSON.parse(turn.finalResponse);
      console.log(JSON.stringify(result, null, 2));
    } catch {
      // 如果 Codex 返回的不是纯 JSON，包装它
      console.log(JSON.stringify({
        critical: [],
        warning: [],
        info: [],
        summary: "Codex 审查完成",
        rawResponse: turn.finalResponse
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      error: true,
      message: error.message || "Codex API 调用失败",
      hint: "请检查网络连接和 API Key 是否有效"
    }));
    process.exit(1);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";

    // 检查是否有 stdin 输入
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));

    // 超时保护：10 秒后返回已收集的数据
    setTimeout(() => {
      if (data) resolve(data);
    }, 10000);
  });
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: true,
    message: error.message
  }));
  process.exit(1);
});
```

**Step 2: 验证脚本语法**

Run: `node --check scripts/codex-reviewer/index.js`
Expected: 无输出（语法正确）

**Step 3: Commit**

```bash
git add scripts/codex-reviewer/index.js
git commit -m "feat: 实现 codex-reviewer 主脚本 #0000"
```

---

## Task 3: 创建 Skill 定义

**Files:**
- Create: `skills/codex-reviewer/SKILL.md`

**Step 1: 创建 Skill 文件**

```markdown
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

确保已配置 `OPENAI_API_KEY` 环境变量：
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
- "OPENAI_API_KEY 环境变量未设置" → 提示用户配置 API Key
- "Codex API 调用失败" → 建议检查网络或稍后重试

## 使用示例

```
用户: 用 Codex 审查一下我的代码
用户: 做个深度安全审计
用户: 给个第二意见，交叉验证一下
用户: /codex-review
```
```

**Step 2: 验证 Skill 目录结构**

Run: `ls -la skills/codex-reviewer/`
Expected: 显示 SKILL.md

**Step 3: Commit**

```bash
git add skills/codex-reviewer/
git commit -m "feat: 创建 codex-reviewer Skill 定义 #0000"
```

---

## Task 4: 创建 Command 入口

**Files:**
- Create: `commands/codex-review.md`

**Step 1: 创建 Command 文件**

```markdown
---
name: codex-review
description: "使用 Codex 进行深度代码审查"
arguments: "[--staged|--branch <name>|<file>]"
skill: codex-reviewer
---

# Codex 代码审查

调用 OpenAI Codex 对代码变更进行深度审查。

## 参数说明

- 无参数：审查最近一次提交的变更
- `--staged`：审查暂存区的变更
- `--branch <name>`：审查指定分支与当前分支的差异
- `<file>`：审查指定文件（未实现）

## 示例

```bash
/codex-review              # 审查最近提交
/codex-review --staged     # 审查暂存变更
```
```

**Step 2: 验证 Command 文件**

Run: `cat commands/codex-review.md`
Expected: 显示完整的 Command 定义

**Step 3: Commit**

```bash
git add commands/codex-review.md
git commit -m "feat: 创建 /codex-review 命令入口 #0000"
```

---

## Task 5: 安装依赖并本地测试

**Files:**
- Modify: `scripts/codex-reviewer/` (npm install)

**Step 1: 安装 npm 依赖**

Run: `cd scripts/codex-reviewer && npm install`
Expected: 安装 @openai/codex-sdk 成功

**Step 2: 添加 node_modules 到 .gitignore**

检查项目根目录 .gitignore 是否已包含 node_modules，如果没有则添加：
```
node_modules/
```

**Step 3: 测试脚本（无输入）**

Run: `echo "" | node scripts/codex-reviewer/index.js`
Expected: 返回 JSON，包含 "没有待审查的代码变更"

**Step 4: 测试脚本（模拟 diff 输入，需要 API Key）**

如果配置了 OPENAI_API_KEY：
Run: `echo "diff --git a/test.js b/test.js\n+console.log('test')" | node scripts/codex-reviewer/index.js`
Expected: 返回审查结果 JSON

**Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: 安装 codex-reviewer 依赖 #0000"
```

---

## Task 6: 更新 README 文档

**Files:**
- Modify: `README.md`

**Step 1: 在 README 中添加 codex-reviewer 说明**

在现有 Skills 列表中添加：

```markdown
### codex-reviewer

使用 OpenAI Codex SDK 进行深度代码审查。

**触发方式：**
- 命令：`/codex-review`
- 关键词：codex 审查、深度审查、安全审计、交叉验证

**配置要求：**
```bash
export OPENAI_API_KEY="sk-..."
```

**与 superpowers 协作：**
- 常规审查：superpowers:code-reviewer
- 深度审查/安全审计：codex-reviewer
- 重要变更：两者都用，交叉验证
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: 更新 README 添加 codex-reviewer 说明 #0000"
```

---

## Task 7: 集成测试

**Step 1: 重新加载插件**

在 Claude Code 中执行：
```
/plugin uninstall froggo-skills
/plugin install /Users/lg/workspace/froggo-skills
```

**Step 2: 测试命令触发**

执行：`/codex-review --staged`
Expected: 如果有暂存变更，返回审查结果；否则提示无变更

**Step 3: 测试关键词触发**

输入：`用 Codex 做个深度安全审计`
Expected: Claude 识别并调用 codex-reviewer Skill

**Step 4: 验证与 superpowers 协作**

输入：`帮我做代码审查`
Expected: Claude 使用 superpowers:code-reviewer（而非 codex-reviewer）

输入：`再用 Codex 交叉验证一下`
Expected: Claude 使用 codex-reviewer

---

## 完成检查清单

- [ ] Task 1: 脚本目录结构
- [ ] Task 2: Node.js 主脚本
- [ ] Task 3: Skill 定义
- [ ] Task 4: Command 入口
- [ ] Task 5: 依赖安装和本地测试
- [ ] Task 6: README 文档更新
- [ ] Task 7: 集成测试
