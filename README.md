# froggo-skills

开发人员工作流增强技能，用于 Claude Code。

## 技能列表

| 技能 | 触发方式 | 说明 |
|------|----------|------|
| doc-writer | 写文档时自动触发 | 定义文档输出规范 |
| doc-reader | `/read-doc` 手动触发 | 定义文档搜索读取规范 |
| git-commit | 提交时自动触发 | Conventional Commits 规范 |
| zentao-sync | `/zentao-sync` 手动触发 | 禅道任务同步到 Obsidian |

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

## 配置覆盖

在项目 `CLAUDE.md` 中可覆盖默认配置：

```markdown
## froggo-skills 配置

- doc_root: /custom/path/to/docs
- templates_dir: /custom/path/to/templates
```

## License

MIT
