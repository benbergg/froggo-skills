---
name: git-commit
description: "自动触发：执行 git commit 时，确保提交信息符合 Conventional Commits 规范"
---

# Git 提交规范

当提交代码时，请遵循以下规范生成提交信息。

## 格式

```
<type>: <description> #<zentao_id>
```

## Type 类型

| Type | 说明 | 示例 |
|------|------|------|
| feat | 新功能 | `feat: 添加用户登录功能 #T1234` |
| hotfix | 修复 bug | `hotfix: 修复登录验证失败 #B5678` |
| docs | 文档变更 | `docs: 更新API接口文档 #0000` |
| style | 代码格式（不影响功能） | `style: 格式化代码缩进 #0000` |
| refactor | 重构（不新增功能、不修复bug） | `refactor: 重构用户认证模块 #T1234` |
| perf | 性能优化 | `perf: 优化列表查询性能 #T1234` |
| test | 测试相关 | `test: 添加登录单元测试 #T1234` |
| chore | 构建/工具/依赖 | `chore: 更新依赖版本 #0000` |
| revert | 回滚 | `revert: 回滚登录功能变更 #T1234` |

## 规则

1. **type**：英文小写，从上表中选择
2. **description**：中文描述，简洁说明变更内容
3. **zentao_id**：禅道任务/Bug号
   - 任务：`#T1234`
   - Bug：`#B5678`
   - 无关联：`#0000`
4. **长度**：整行不超过 72 字符

## 示例

### 单行提交

```
feat: 添加用户积分系统 #T1234
hotfix: 修复积分计算精度问题 #B5678
docs: 更新积分API文档 #T1234
refactor: 重构积分服务模块 #T1234
chore: 升级Spring Boot版本 #0000
```

### 多行提交（复杂变更）

```
feat: 添加用户积分系统 #T1234

- 新增积分表结构
- 实现积分增减 API
- 添加积分查询接口
- 编写单元测试
```

## 触发时机

以下场景自动应用本规范：

1. 用户请求提交代码时
2. 执行 `/commit` 命令时
3. 代码变更后询问是否提交时

## 提交前检查

提交前确认：

- [ ] type 选择正确
- [ ] description 清晰描述了变更内容
- [ ] zentao_id 正确关联（或使用 #0000）
- [ ] 整行长度不超过 72 字符
