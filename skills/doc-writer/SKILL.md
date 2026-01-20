---
name: doc-writer
description: "自动触发：创建需求、设计、任务、计划等文档时，按规范输出到知识库（命令：/write-doc）"
---

# 文档写入规范

当你需要创建或保存文档时，请遵循以下规范。

## 默认配置

| 配置项 | 默认值 |
|--------|--------|
| doc_root | `~/workspace/Knowledge-Library/` |
| templates_dir | `~/workspace/Knowledge-Library/06-Templates/` |

## 文档类型映射

根据文档类型，输出到对应目录并使用规范的命名格式：

| 类型 | 目录 | 命名格式 | 模板 |
|------|------|----------|------|
| 需求文档 | `01-Requirements/` | `yyyyMMdd-序号-名称.md` | requirement.md |
| 任务文档 | `02-Tasks/` | `yyyyMMdd-禅道ID-名称.md` | task.md |
| 开发计划 | `03-Plans/` | `yyyyMMdd-禅道ID-名称.md` | plan.md |
| 设计文档 | `04-Designs/` | `yyyyMMdd-禅道ID-名称.md` | design.md |
| 周报 | `05-Reports/weekly/` | `YYYY-WXX.md` | weekly.md |
| KPR | `05-Reports/KPR/` | `YYYY-QX-KPR.md` | kpr.md |
| 技术笔记 | `07-Tech/` | `yyyyMMdd-主题-描述.md` | tech-note.md |
| API文档 | `07-Tech/` | `yyyyMMdd-API-名称.md` | api.md |

### 命名说明

- `yyyyMMdd`：日期格式，如 `20250118`
- `序号`：三位数序号，如 `001`、`002`
- `禅道ID`：禅道任务号如 `T1234`、Bug号如 `B5678`，无禅道任务时用 `0000`
- `YYYY-WXX`：年份-周数，如 `2025-W03`
- `YYYY-QX`：年份-季度，如 `2025-Q1`

## Frontmatter 规范

所有文档必须包含以下 frontmatter 属性：

```yaml
---
created: 2025-01-18
updated: 2025-01-18
project: 项目名称
status: 进行中
tags:
---
```

### 项目名称可选值

- `bytenew-llm`
- `voc-htm`
- `bytenew-smartscene`
- `bytenew-basic-engine`
- 其他项目名称

### 状态可选值

- `进行中`
- `已完成`
- `暂停`

### 任务文档额外属性

```yaml
zentao_id: T1234
branch: feature/xxx
published: 未发布
deployed: dev
```

- `published`：`未发布` / `已发布`
- `deployed`：`dev` / `testc` / `pre` / `pro` / `oly` / `pg` / `ysld`

## 触发条件

以下场景自动应用本规范：

1. brainstorming 完成后输出设计文档
2. 用户要求创建需求文档
3. 用户要求创建开发计划
4. 用户要求创建技术笔记
5. 用户要求创建周报或 KPR
6. 用户要求创建 API 文档

## 配置覆盖

用户可在项目 `CLAUDE.md` 中覆盖默认配置：

```markdown
## froggo-skills 配置

- doc_root: /custom/path/to/docs
- templates_dir: /custom/path/to/templates
```
