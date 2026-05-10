# froggo-skills

开发人员工作流增强技能,用于 Claude Code。

## 架构说明

```
froggo-skills/
├── .claude-plugin/
│   ├── plugin.json          # 插件元数据
│   └── marketplace.json
├── skills/                   # 技能(自动或手动触发的工作流规范)
│   ├── git-commit/
│   ├── zentao-api/
│   ├── weekly-report/
│   ├── exp-compass-daily/
│   ├── prompt-engineering/
│   └── dingtalk-log/        # WIP
├── commands/                 # 命令入口(/xxx)
└── hooks/
    └── hooks.json           # Hook 配置(可选)
```

**Skills**:定义工作流规范,可自动或手动触发
**Commands**:用户命令入口(`/xxx`),调用对应 skill 执行

## 技能列表

| 技能 | 触发方式 | 说明 |
|------|----------|------|
| [git-commit](skills/git-commit/SKILL.md) | 自动(commit 时) | Conventional Commits 提交规范 |
| [zentao-api](skills/zentao-api/SKILL.md) | 自动(查/写禅道时) | 禅道 RESTful API v1 读 + 受控写(任务/Bug 全生命周期,无 DELETE) |
| [weekly-report](skills/weekly-report/SKILL.md) | 手动 + cron | 产研周报自动生成:Node 采集 → AI 撰写 → 7 项断言自检 → 写入 Knowledge-Library |
| [exp-compass-daily](skills/exp-compass-daily/SKILL.md) | 手动 | 体验罗盘日报:禅道采集 → AI 撰写 → 6 项自检 → 钉钉 OA 日志推送 |
| [prompt-engineering](skills/prompt-engineering/SKILL.md) | 自动(写 prompt 时) | few-shot / CoT / ReAct 等生产级 prompt 模板 |
| [dingtalk-log](skills/dingtalk-log/SKILL.md) | – | 通用钉钉日志 OpenAPI 封装 CLI(WIP,实现中) |

## 安装

在 Claude Code 中使用 `/plugin` 命令:

```bash
/plugin marketplace add benbergg/froggo-skills
/plugin install froggo-skills@froggo-skills
# 重启 Claude Code 生效
```

卸载:

```bash
/plugin uninstall froggo-skills
/plugin marketplace remove froggo-skills
```

## 环境变量速查

仅列**必填**和**关键可选**项;详细描述见各 SKILL.md。建议放 `~/.openclaw/.env`(生产)或 `~/.zentao.env`(本机调试),`chmod 600`,然后 `set -a; source <文件>; set +a`。

| Skill | 必填 | 关键可选 |
|------|------|---------|
| zentao-api | `ZENTAO_BASE_URL` `ZENTAO_ACCOUNT` `ZENTAO_PASSWORD` | – |
| weekly-report | 同 zentao-api | `ZENTAO_ME` `KNOWLEDGE_LIB`(默认 `~/Knowledge-Library`) `AI_DAILY_DIR` `WEEKLY_API_BUDGET`(默认 2000) `WEEKLY_HARD_TIMEOUT_MS`(默认 600000) `WEEKLY_ALLOW_PARTIAL` |
| exp-compass-daily | 同 zentao-api + `DINGTALK_APPKEY` `DINGTALK_APPSECRET` `DINGTALK_USERID` `DINGTALK_TEMPLATE_ID` | `ZENTAO_PRODUCTS`(默认 `95`) `EXP_COMPASS_API_BUDGET`(默认 300) `DINGTALK_TO_CHAT` `DRY_RUN` |
| git-commit / prompt-engineering / dingtalk-log | – | – |

示例 `~/.zentao.env`:

```bash
ZENTAO_BASE_URL=https://chandao.example.com/zentao/api.php/v1
ZENTAO_ACCOUNT=your_account
ZENTAO_PASSWORD=your_password
# weekly / exp-compass 按需追加
KNOWLEDGE_LIB=/Users/you/Knowledge-Library
DINGTALK_APPKEY=...
```

## 使用速览

### Git 提交

遵循 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/) 规范,英文撰写。

```bash
feat: add user login
fix: correct token validation
docs: update API reference
chore: bump spring boot to 3.4.0
```

Type:`feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`。详见 [skills/git-commit/SKILL.md](skills/git-commit/SKILL.md)。

### 禅道 API 查询

通过禅道 RESTful API v1 读+受控写,自动管理 token 与 user 视图缓存。详见 [skills/zentao-api/SKILL.md](skills/zentao-api/SKILL.md)。

### 周报 / 日报

- 周报:触发词 `周报` / `weekly report`,产物写入 `$KNOWLEDGE_LIB/05-Reports/weekly/{WK}-工作周报.md`,详见 [skills/weekly-report/SKILL.md](skills/weekly-report/SKILL.md)。
- 日报:触发词 `体验罗盘` / `daily compass`,推送钉钉 OA 日志,详见 [skills/exp-compass-daily/SKILL.md](skills/exp-compass-daily/SKILL.md)。

## License

MIT
