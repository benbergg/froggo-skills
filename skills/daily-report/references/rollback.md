# Rollback Operations

> 触发条件、操作步骤、检查 checklist。详细背景见设计文档 §11.5。

## 触发条件

- 真实部署后偏差 > 10%(§10.3)
- 连续 3 天 API 预算熔断
- 评测连续 3 天失败
- 知识库被脏数据污染

## 操作 1:plugin.json 版本回退

```bash
cd /Users/lg/workspace/froggo-skills
git log --oneline -- .claude-plugin/plugin.json | head
git checkout <prev-commit> -- .claude-plugin/plugin.json
git commit -m "chore: rollback plugin.json to 1.26.0 (daily-report rollback)"
```

## 操作 2:skill 删除(可选)

**完全删除**:
```bash
git rm -r skills/daily-report/
git commit -m "feat(daily-report)!: remove skill due to rollback"
```

**保留代码不暴露**(改 description 删触发关键词):
```bash
# 编辑 plugin.json 的 description,移除"产研日报、日报"等关键词
git commit -am "chore(daily-report): hide skill triggers (rollback)"
```

## 操作 3:已生成日报清理

**选项 a:git revert(保留历史可追溯)**
```bash
cd ~/Knowledge-Library/05-Reports/daily
git log --oneline | grep daily | head -7
git revert <commit-list>
```

**选项 b:标 deprecated(保留文件)**
```bash
cd ~/Knowledge-Library/05-Reports/daily
for f in 2026-05-*.md; do
  sed -i '' 's/^status: published$/status: deprecated\nrollback_reason: <填理由>/' "$f"
done
git add -A && git commit -m "docs: deprecate daily-report files (rollback)"
```

## 操作 4:cron 摘除

```bash
# openclaw 上
ssh openclaw 'crontab -e'   # 删 daily-report 行
```

## 检查 checklist

- [ ] `/plugin list` 中 daily-report 不再触发
- [ ] 知识库 `daily/` 目录无新增
- [ ] cron 不再调用
- [ ] 团队飞书告知 rollback 完成
- [ ] 触发条件归零(若是数据偏差,确认数据修复)
