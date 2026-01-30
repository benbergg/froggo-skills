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
  // 注意：Codex SDK 支持多种认证方式：
  // 1. ChatGPT 订阅用户：自动使用登录凭据，无需 API Key
  // 2. API 用户：需要设置 OPENAI_API_KEY 环境变量

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
      hint: "请确保已登录 Codex（codex login）或检查网络连接"
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
