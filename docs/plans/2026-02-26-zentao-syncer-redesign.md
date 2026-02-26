# zentao-syncer 重构设计

## 背景

现有 zentao-syncer 使用独立的 `zentao-scraper.js` 脚本通过 playwright-skill 的 `run.js` 执行浏览器自动化，存在以下问题：
- 每次都需要重新登录，速度慢且不稳定
- 依赖外部 playwright-skill 插件的 run.js
- 需要维护 JS 脚本中的 CSS 选择器

## 目标

用 playwright-cli 命令序列替代 JS 脚本，解决登录持久化问题，提升可靠性。

## 方案概要

### 变更范围

**删除：**
- `skills/zentao-syncer/scripts/zentao-scraper.js`
- `commands/zentao-sync.md`

**重写：**
- `skills/zentao-syncer/SKILL.md`

### 触发方式

去掉 `/zentao-sync` 命令，改为纯 skill 自动触发。关键词：同步禅道、禅道任务、禅道Bug、zentao sync、T1234、B5678。

### 登录策略

三层机制：

1. **直接访问**：playwright-cli 默认持久化 profile，cookie 跨次保留。直接 goto 目标页，snapshot 检查是否在登录页。
2. **自动登录**：若在登录页，读取 `ZENTAO_USER` / `ZENTAO_PASSWORD` 环境变量，fill 用户名密码，勾选"保持登录"，click 登录。
3. **未配置提示**：环境变量未设置时提示用户配置。

登录检测：页面 URL 包含 `user-login` 或 title 包含 `用户登录`。

### 数据抓取流程

```
1. playwright-cli open（不加 --isolated，保持持久化 profile）
2. goto 目标页 https://chandao.bytenew.com/zentao/{type}-view-{id}.html
3. snapshot → 检查登录状态
4. 若未登录 → 登录流程 → 重新 goto
5. snapshot → 获取详情页结构
6. eval / run-code 在 iframe 中提取结构化数据
7. close
```

禅道使用双层 iframe 结构，playwright-cli snapshot 自动穿透 iframe，eval 需通过 run-code 进入正确 iframe context。

### 抓取字段

**任务 (Task)：** 标题、优先级、预计工时、指派人、状态、开始日期、截止日期、所属执行、相关需求、描述

**Bug：** 标题、优先级、严重程度、指派人、状态、Bug类型、所属产品、所属模块、描述

### Git 分支推荐

| 禅道类型 | git type | 分支格式 | 示例 |
|----------|----------|----------|------|
| Bug (B) | hotfix | `hotfix/B{id}-{简短描述}` | `hotfix/B49622-评价标签正负面显示错误` |
| Task (T) | feat | `feat/T{id}-{简短描述}` | `feat/T1234-商品数据源对接` |

简短描述：去掉日期前缀（如 `【20260226】`），截取前 20 字符，替换空格为 `-`。

文档 frontmatter 新增：`git_branch`、`zentao_url`。

### 错误处理

| 场景 | 处理 |
|------|------|
| playwright-cli 未安装 | 提示 npx playwright-cli 或安装指引 |
| Chrome 占用冲突 | 使用 `--browser=chromium` 回退 |
| 登录失败 | 检测错误提示，输出具体原因 |
| 环境变量未配置且未登录 | 提示设置环境变量 |
| 任务/Bug 不存在 | 检测 404 或错误页面 |
| 页面加载超时 | 重试一次，仍失败则截图报告 |

### 依赖

- playwright-cli（外部 CLI）
- doc-writer skill
- obsidian:obsidian-markdown skill
- git-commit skill（分支命名规范参考）
