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

| 技能 | 触发方式 | 命令 | 说明 |
|------|----------|------|------|
| git-commit | 自动 | - | Conventional Commits 提交规范 |
| zentao-api | 自动 | - | 禅道 RESTful API v1 读+受控写（任务/Bug/需求等，无 DELETE） |

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

## License

MIT
