# Daily Report Template

## Render Entry Point

```bash
source references/scripts/progress.sh
source references/scripts/collect-tasks.sh
source references/scripts/render.sh

render_markdown /tmp/daily-${TODAY}.aggregated.json > /tmp/daily-${TODAY}.md
```

## Frontmatter Fields (required)

```yaml
---
created: <ISO datetime>
updated: <ISO datetime>
type: daily-report
date: <YYYY-MM-DD>
products: <[id,...]>
status: published
tags: [日报, 禅道, 产研日报]
---
```

## Section Structure

1. `# 产研日报 · YYYY-MM-DD`
2. `## 概览` — total counts + today's changes
3. `## 产品 X · #ID` (one section per product)
   - `### 📋 需求处理情况`
     - `#### 🔄 进行中` (all tasks expanded with progress)
     - `#### ✅ 今日完成`
     - `#### ⚠️ 未分配`
     - `#### ⏸ 未执行`
   - `### 🐛 Bug 处理情况` — table with today's events
4. `## 备注`

## Copy Style (see design §6.3)

- All IDs use wikilinks: `[[Sxxx]]` / `[[Bxxx]]` / `[[Txxx]]`
- Task type emoji comes from `task_type_label` in `collect-tasks.sh`
- Progress bar: 10 cells + numeric % + `(工时|数量|阶段)` label
- Unknown accounts show ` ⚠️` suffix (mapped via `~/.zentao-roles.yaml`)

## Feishu Summary

Assembled separately by `feishu-push.sh` from the aggregated JSON; see design §6.2 for template.
