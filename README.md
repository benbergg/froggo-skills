# froggo-skills

开发人员工作流增强技能，用于 Claude Code。

## 架构说明

本插件包含两类组件：

```
froggo-skills/
├── skills/          # 技能（自动或手动触发的工作流规范）
│   ├── froggo-workflow/  # 开发流程规范（主控）
│   ├── doc-reader/
│   ├── doc-writer/
│   ├── git-commit/
│   ├── zentao-syncer/
│   ├── lib-docs/
│   ├── code-search/
│   └── session-context/
└── commands/        # 命令（用户入口，调用对应 skill）
    ├── froggo-workflow.md → froggo-workflow
    ├── read-doc.md   → doc-reader
    ├── write-doc.md  → doc-writer
    └── zentao-sync.md → zentao-syncer
```

**Skills**：定义工作流规范，可自动或手动触发
**Commands**：用户命令入口（`/xxx`），调用对应 skill 执行

## 技能列表

| 技能 | 触发方式 | 命令 | 说明 |
|------|----------|------|------|
| **froggo-workflow** | **手动** | **`/froggo-workflow`** | **9阶段开发流程规范（主控）** |
| doc-reader | 自动 | `/read-doc` | 从知识库搜索读取文档 |
| doc-writer | 自动 | `/write-doc` | 按规范输出文档到知识库 |
| git-commit | 自动 | - | Conventional Commits 提交规范 |
| zentao-syncer | 手动 | `/zentao-sync` | 禅道任务同步到 Obsidian |
| lib-docs | 自动 | - | 使用 Context7 获取库文档 |
| code-search | 自动 | - | Claude Context 代码语义搜索 |
| session-context | 手动/自动 | - | 搜索会话历史恢复上下文 |

### MCP 依赖

| MCP | 技能 | 说明 |
|-----|------|------|
| context7 | lib-docs, froggo-workflow | 获取库/框架官方文档 |
| serena | froggo-workflow | 项目结构分析 |
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

### 开发流程

启动完整开发流程：

```bash
/froggo-workflow           # 完整模式（9阶段）
/froggo-workflow quick     # 快速模式（7阶段，跳过评审）
```

流程阶段：需求分析 → 设计 → 评审 → 计划 → 开发 → 测试 → Review → 提交 → 归档

特性：
- 技术调研强制检查（context7/serena/doc-reader）
- 每个阶段用户确认门禁
- 产出物自动归档到知识库

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

## 配置覆盖

在项目 `CLAUDE.md` 中可覆盖默认配置：

```markdown
## froggo-skills 配置

- doc_root: /custom/path/to/docs
- templates_dir: /custom/path/to/templates
```

## License

MIT
