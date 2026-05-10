# froggo-skills

开发人员工作流增强技能，用于 Claude Code。

## 架构说明

```
froggo-skills/
├── .claude-plugin/
│   └── plugin.json     # 插件元数据
├── skills/             # 技能（自动或手动触发的工作流规范）
│   ├── git-commit/
│   └── zentao-api/
├── commands/           # 命令入口（/xxx）
├── agents/             # Subagent 定义
└── hooks/
    └── hooks.json      # Hook 配置
```

**Skills**：定义工作流规范，可自动或手动触发
**Commands**：用户命令入口（`/xxx`），调用对应 skill 执行

## 技能列表

| 技能 | 触发方式 | 说明 |
|------|----------|------|
| [git-commit](skills/git-commit/SKILL.md) | 自动（commit 时） | Conventional Commits 提交规范 |
| [zentao-api](skills/zentao-api/SKILL.md) | 自动（查/写禅道时） | 禅道 RESTful API v1 读 + 受控写（任务/Bug 全生命周期，无 DELETE） |
| [weekly-report](skills/weekly-report/SKILL.md) | 手动 + cron | 产研周报自动生成：Node 采集 → AI 撰写 → 7 项断言自检 → 写入 Knowledge-Library |
| [exp-compass-daily](skills/exp-compass-daily/SKILL.md) | 手动 | 体验罗盘日报：禅道采集 → AI 撰写 → 6 项自检 → 钉钉 OA 日志推送 |
| [prompt-engineering](skills/prompt-engineering/SKILL.md) | 自动（写 prompt 时） | few-shot / CoT / ReAct 等生产级 prompt 模板 |

## 安装

在 Claude Code 中使用 `/plugin` 命令安装：

```bash
# 1. 添加 marketplace
/plugin marketplace add benbergg/froggo-skills

# 2. 安装插件
/plugin install froggo-skills@froggo-skills

# 3. 重启 Claude Code 生效
```

卸载：

```bash
/plugin uninstall froggo-skills
/plugin marketplace remove froggo-skills
```

## 使用

### Git 提交

遵循 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/) 国际标准，使用英文撰写。

格式：`<type>[!]: <description>`

```bash
feat: add user login
fix: correct token validation
docs: update API reference
chore: bump spring boot to 3.4.0
```

Type 类型：`feat` | `fix` | `docs` | `style` | `refactor` | `perf` | `test` | `build` | `ci` | `chore` | `revert`

详细规范见 [skills/git-commit/SKILL.md](skills/git-commit/SKILL.md)。

### 禅道 API 查询

通过禅道 RESTful API v1 进行只读查询，自动管理 token 与 user 视图缓存。需要环境变量：

```bash
export ZENTAO_BASE_URL="https://chandao.example.com/zentao/api.php/v1"
export ZENTAO_ACCOUNT="your_account"
export ZENTAO_PASSWORD="your_password"
```

详细使用见 [skills/zentao-api/SKILL.md](skills/zentao-api/SKILL.md)。

## 环境变量规范

按命名空间分**全局共享**和**skill 级**两层。脚本只信 `process.env`，**不再 source `.env` 文件** —— 由调用方负责注入（本地用 shell rc / GUI 用 launchctl / 服务器用 systemd EnvironmentFile）。

### 命名规范

| 类别 | 前缀 | 示例 |
|---|---|---|
| 全局凭据 | `ZENTAO_*` / `DINGTALK_APPKEY|APPSECRET|USERID` | 多 skill 共享禅道实例与钉钉企业应用 |
| skill 级钉钉配置 | `DINGTALK_<SKILL_NAME>_*` | `DINGTALK_EXP_COMPASS_TEMPLATE_ID` / `DINGTALK_EXP_COMPASS_TO_CHAT` |
| skill 级业务参数 | `<SKILL_NAME>_*` | `EXP_COMPASS_PRODUCTS` / `WEEKLY_API_BUDGET` |

新增需要钉钉日志推送能力的 skill 时，沿用 `DINGTALK_<SKILL>_*` 前缀，凭据共享，模板/收件人 skill 级隔离。

### 各 skill 必填一览

| Skill | 必填 | 关键可选 |
|------|------|---------|
| zentao-api | `ZENTAO_BASE_URL` `ZENTAO_ACCOUNT` `ZENTAO_PASSWORD` | – |
| weekly-report | 同 zentao-api + `KNOWLEDGE_LIB` | `ZENTAO_ME` `AI_DAILY_DIR` `WEEKLY_API_BUDGET`（默认 2000） `WEEKLY_HARD_TIMEOUT_MS`（默认 600000） `WEEKLY_ALLOW_PARTIAL` |
| exp-compass-daily | 同 zentao-api + `DINGTALK_APPKEY` `DINGTALK_APPSECRET` `DINGTALK_USERID` + `DINGTALK_EXP_COMPASS_TEMPLATE_ID` 或 `_TEMPLATE_NAME` | `EXP_COMPASS_PRODUCTS`（默认 95） `EXP_COMPASS_API_BUDGET`（默认 300） `EXP_COMPASS_HARD_TIMEOUT_MS`（默认 600000） `DINGTALK_EXP_COMPASS_TO_CHAT/USERIDS/CIDS` `DRY_RUN` |
| git-commit / prompt-engineering | – | – |

### 加载机制

- **本地 macOS shell：** 在 `~/.zshrc` 或 `~/.zshenv` 里 `export`（zsh GUI 不读 `~/.zprofile`）
- **本地 GUI 启动的 Claude Code：** `~/.zshenv` 或 `launchctl setenv KEY VALUE`
- **服务器 systemd 进程（如 openclaw cron）：** 写入 EnvironmentFile，并在白名单（如 `OPENCLAW_SERVICE_MANAGED_ENV_KEYS`）追加 key，`systemctl --user daemon-reload && systemctl --user restart <unit>`

`~/.zshenv` 模板示例：

```bash
# 全局共享
export ZENTAO_BASE_URL=https://chandao.example.com/zentao/api.php/v1
export ZENTAO_ACCOUNT=...
export ZENTAO_PASSWORD=...
export DINGTALK_APPKEY=...
export DINGTALK_APPSECRET=...
export DINGTALK_USERID=...

# exp-compass-daily skill 级
export DINGTALK_EXP_COMPASS_TEMPLATE_ID=...
# 或：export DINGTALK_EXP_COMPASS_TEMPLATE_NAME=体验罗盘-每日进度播报
# export DINGTALK_EXP_COMPASS_TO_CHAT=true
# export EXP_COMPASS_PRODUCTS=95
```

## License

MIT
