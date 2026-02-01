---
name: agent-browser
description: Use when automating browser tasks via CLI - navigation, form filling, screenshots, scraping. Triggers on keywords: agent-browser, headless browser, browser automation CLI, @ref element, accessibility snapshot, Vercel browser
---

# agent-browser: AI 浏览器自动化 CLI

## Overview

Vercel Labs 开发的 headless 浏览器 CLI，专为 AI agent 设计。核心特性：
- **@ref 引用**：通过 `@e1`, `@e2` 确定性元素定位
- **Accessibility 快照**：为 AI 优化的页面结构
- **Rust 原生**：高性能，Node.js 回退

## 安装

```bash
npm install -g agent-browser
agent-browser install  # 下载 Chromium
```

## Token 节省（重要）

**始终使用 `snapshot -i` 而非完整 snapshot！**

| 模式 | 输出大小 | 节省 |
|------|----------|------|
| `snapshot` | 47KB | - |
| `snapshot -i` | 7KB | **83%** |

```bash
# 推荐：最省 token 的 snapshot
agent-browser snapshot -i
```

## 核心工作流

```bash
# 1. 导航
agent-browser open https://example.com

# 2. 获取快照（必须用 -i 节省 token）
agent-browser snapshot -i

# 3. 交互
agent-browser click @e3
agent-browser fill @e5 "text"

# 4. 页面变化后重新快照
agent-browser snapshot -i
```

## Quick Reference

| 类别 | 命令 | 示例 |
|------|------|------|
| **导航** | `open`, `back`, `forward`, `reload` | `open https://example.com` |
| **点击** | `click`, `dblclick`, `hover` | `click @e3` |
| **输入** | `fill`, `type`, `press` | `fill @e5 "hello"`, `press Enter` |
| **表单** | `select`, `check`, `uncheck`, `upload` | `select @e7 "option1"` |
| **快照** | `snapshot [-i] [-c] [-d n]` | `snapshot -i` |
| **滚动** | `scroll <方向> [像素]` | `scroll down 1000` |
| **等待** | `wait <选择器\|毫秒>` | `wait @e3`, `wait 2000` |
| **截图** | `screenshot`, `pdf` | `screenshot page.png` |
| **JS** | `eval` | `eval "document.title"` |
| **标签页** | `tab new/list/close/<n>` | `tab new`, `tab 0` |
| **语义查找** | `find <类型> <值> <动作>` | `find text "登录" click` |

### Snapshot 选项

| 选项 | 说明 | 推荐 |
|------|------|------|
| `-i, --interactive` | 只显示可交互元素 | ✅ 必用 |
| `-c, --compact` | 移除空结构元素 | 可选 |
| `-d <n>, --depth` | 限制树深度 | 可选 |
| `-s <sel>, --selector` | CSS 选择器范围 | 可选 |
| `--json` | JSON 输出 | 数据提取时用 |

### 全局选项（注意：空格分隔，非等号）

```bash
# ✅ 正确格式
agent-browser --session mySession open https://example.com
agent-browser --profile /tmp/my-profile open https://example.com
agent-browser --headed open https://example.com

# ❌ 错误格式
agent-browser --profile=/tmp/my-profile open https://example.com
```

## 常见场景

### 需要登录的网站（重要）

```bash
# 1. 用 headed + profile 打开，手动登录
agent-browser --headed --profile /tmp/site-profile open https://login.example.com

# 2. 手动完成登录后，后续命令自动保持登录态
agent-browser --profile /tmp/site-profile open https://example.com/dashboard
agent-browser snapshot -i
```

**注意**：profile 在浏览器关闭后可能丢失，需重新登录。

### 数据抓取

```bash
agent-browser open https://example.com/list
agent-browser snapshot -i
agent-browser scroll down 2000  # 加载更多
agent-browser wait 1000
agent-browser snapshot -i

# 用 JS 提取数据（必须用 IIFE 包装）
agent-browser eval "(() => {
  const items = [];
  document.querySelectorAll('.item').forEach(el => {
    items.push(el.textContent.trim());
  });
  return JSON.stringify(items);
})()"
```

### 天猫/淘宝评价抓取

```bash
# 1. 登录后打开商品页
agent-browser --profile /tmp/tmall open https://detail.tmall.com/item.htm?id=xxx

# 2. 滚动到评价区域
agent-browser scroll down 2000
agent-browser wait 2000

# 3. 用 JS 点击展开评价（find 可能匹配多元素）
agent-browser eval "(() => {
  const el = Array.from(document.querySelectorAll('*')).find(e =>
    e.textContent.trim() === '查看全部评价'
  );
  if (el) { el.click(); return 'clicked'; }
  return 'not found';
})()"

# 4. 等待加载后获取评价
agent-browser wait 3000
agent-browser snapshot | grep "已购"
```

### 表单填写

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
agent-browser fill @e2 "user@example.com"
agent-browser fill @e3 "password"
agent-browser click @e4  # 提交按钮
agent-browser wait 2000
agent-browser snapshot -i
```

## 常见陷阱

### eval 必须用 IIFE 包装

```bash
# ❌ 报错：Illegal return statement
agent-browser eval "return document.title"

# ✅ 用 IIFE 包装
agent-browser eval "(() => { return document.title; })()"

# ✅ 简单表达式可以不用 return
agent-browser eval "document.title"
```

### find 命令多元素匹配

```bash
# ❌ 报错：strict mode violation，匹配到多个元素
agent-browser find text "用户评价" click

# ✅ 解决方案1：用更精确的文本
agent-browser find text "查看全部评价" click

# ✅ 解决方案2：用 @ref 引用（从 snapshot 获取）
agent-browser click @e15

# ✅ 解决方案3：用 JS 精确查找并点击
agent-browser eval "(() => {
  const el = Array.from(document.querySelectorAll('*')).find(e =>
    e.textContent.trim() === '查看全部评价'
  );
  if (el) { el.click(); return 'clicked'; }
  return 'not found';
})()"
```

### 页面未完全加载

```bash
# ❌ 页面未加载完就操作
agent-browser open https://example.com
agent-browser click @e3  # 可能失败

# ✅ 等待加载
agent-browser open https://example.com
agent-browser wait 1000
agent-browser snapshot -i
agent-browser click @e3
```

### 电商价格混淆

天猫/淘宝使用乱码字符混淆价格，需用 JS 从 DOM 提取真实数据。

## 与 playwright-cli 的区别

| 特性 | agent-browser | playwright-cli |
|------|---------------|----------------|
| 元素引用 | `@e1` | `e1` |
| Token 节省 | `snapshot -i` 省 83% | 无此优化 |
| 性能 | Rust 原生 | Node.js |
| 远程浏览器 | Browserbase/Kernel | 不支持 |
| 参数格式 | 空格分隔 `--opt val` | 等号 `--opt=val` |

## 环境变量

| 变量 | 说明 |
|------|------|
| `AGENT_BROWSER_SESSION` | 默认会话名 |
| `AGENT_BROWSER_PROFILE` | 默认 profile 路径 |
| `AGENT_BROWSER_PROXY` | 代理服务器 |

## 故障排查

```bash
# 可视化调试
agent-browser --headed open https://example.com

# 查看控制台日志
agent-browser console

# 查看网络请求
agent-browser network requests
```
