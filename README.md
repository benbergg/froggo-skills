# froggo-skills

开发人员工作流增强技能，用于 Claude Code。

## 架构说明

本插件包含两类组件：

```
froggo-skills/
├── skills/          # 技能（自动或手动触发的工作流规范）
│   ├── doc-reader/
│   ├── doc-writer/
│   ├── git-commit/
│   ├── zentao-syncer/
│   ├── lib-docs/
│   ├── code-search/
│   ├── session-context/
│   └── skill-router/    # NEW: 智能 skill 路由
├── hooks/           # Hooks（工具调用拦截）
│   └── hooks.json       # NEW: 文档保存格式增强
└── commands/        # 命令（用户入口，调用对应 skill）
    ├── read-doc.md   → doc-reader
    ├── write-doc.md  → doc-writer
    └── zentao-sync.md → zentao-syncer
```

**Skills**：定义工作流规范，可自动或手动触发
**Commands**：用户命令入口（`/xxx`），调用对应 skill 执行

## 技能列表

| 技能 | 触发方式 | 命令 | 说明 |
|------|----------|------|------|
| doc-reader | 自动 | `/read-doc` | 从知识库搜索读取文档 |
| doc-writer | 自动 | `/write-doc` | 按规范输出文档到知识库 |
| git-commit | 自动 | - | Conventional Commits 提交规范 |
| zentao-syncer | 手动 | `/zentao-sync` | 禅道任务同步到 Obsidian |
| lib-docs | 自动 | - | 使用 Context7 获取库文档 |
| code-search | 自动 | - | Claude Context 代码语义搜索 |
| session-context | 手动/自动 | - | 搜索会话历史恢复上下文 |
| skill-router | 自动 | - | 智能匹配 skill，解决名称记忆问题 |

### MCP 依赖

| MCP | 技能 | 说明 |
|-----|------|------|
| context7 | lib-docs | 获取库/框架官方文档 |
| claude-context | code-search, session-context | 代码语义搜索、会话历史搜索 |

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

### 写文档（自动）

当 Claude Code 需要创建文档时，自动按规范输出到指定目录：

| 类型 | 目录 | 命名格式 |
|------|------|----------|
| 需求文档 | `01-Requirements/` | `yyyyMMdd-序号-名称.md` |
| 任务文档 | `02-Tasks/` | `yyyyMMdd-禅道ID-名称.md` |
| 开发计划 | `03-Plans/` | `yyyyMMdd-禅道ID-名称.md` |
| 设计文档 | `04-Designs/` | `yyyyMMdd-禅道ID-名称.md` |
| 周报 | `05-Reports/weekly/` | `YYYY-WXX.md` |
| KPR | `05-Reports/KPR/` | `YYYY-QX-KPR.md` |
| 技术笔记 | `07-Tech/` | `yyyyMMdd-主题-描述.md` |

### 读文档

```bash
/read-doc type:design        # 列出设计文档
/read-doc 登录功能           # 搜索包含关键词的文档
/read-doc zentao:T1234       # 查找关联禅道任务的文档
```

### Git 提交

提交格式：`<type>: <description> #<zentao_id>`

```bash
feat: 添加用户登录功能 #T1234
hotfix: 修复登录验证失败 #B5678
docs: 更新API文档 #0000
```

Type 类型：`feat` | `hotfix` | `docs` | `style` | `refactor` | `perf` | `test` | `chore` | `revert`

### 禅道同步

从禅道同步任务/Bug 自动创建 Obsidian 任务文档：

```bash
/zentao-sync T1234    # 同步任务
/zentao-sync B5678    # 同步 Bug
```

**环境变量配置**（可选，用于自动登录）：

```bash
export ZENTAO_USER="your_username"
export ZENTAO_PASSWORD="your_password"
```

未配置时将打开浏览器，需手动登录。

## Hooks

本插件包含 PreToolUse hook，在文档保存时自动提醒使用 Obsidian Markdown 格式：

- **触发条件**：Write 操作目标为 `.md` 文件或 Knowledge-Library 目录
- **功能**：提醒使用 wikilinks `[[]]`、callouts `> [!note]`、frontmatter 等 Obsidian 特性

## 配置覆盖

在项目 `CLAUDE.md` 中可覆盖默认配置：

```markdown
## froggo-skills 配置

- doc_root: /custom/path/to/docs
- templates_dir: /custom/path/to/templates
```

## License

MIT
