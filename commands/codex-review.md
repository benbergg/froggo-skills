---
name: codex-review
description: "使用 Codex 进行深度代码审查"
arguments: "[--staged|--branch <name>|<file>]"
skill: codex-reviewer
---

# Codex 代码审查

调用 OpenAI Codex 对代码变更进行深度审查。

## 参数说明

- 无参数：审查最近一次提交的变更
- `--staged`：审查暂存区的变更
- `--branch <name>`：审查指定分支与当前分支的差异
- `<file>`：审查指定文件（未实现）

## 示例

```bash
/codex-review              # 审查最近提交
/codex-review --staged     # 审查暂存变更
```
