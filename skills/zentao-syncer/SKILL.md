---
name: zentao-syncer
description: "手动触发：从禅道同步任务/Bug 创建 Obsidian 任务文档（命令：/zentao-sync）"
---

# 禅道任务同步

当用户需要从禅道同步任务或 Bug 到知识库时，请遵循以下规范。

## 禅道地址

| 类型 | URL |
|------|-----|
| 基础地址 | `https://chandao.bytenew.com/zentao/` |
| 任务页面 | `https://chandao.bytenew.com/zentao/task-view-{id}.html` |
| Bug页面 | `https://chandao.bytenew.com/zentao/bug-view-{id}.html` |

## 执行流程

### 1. 解析任务 ID

```
T1234 → 任务 → task-view-1234.html
B5678 → Bug  → bug-view-5678.html
```

### 2. 认证处理

检查环境变量 `ZENTAO_USER` 和 `ZENTAO_PASSWORD`：

**已配置环境变量：**
- 使用 playwright-skill 自动登录禅道
- 登录页面：`https://chandao.bytenew.com/zentao/user-login.html`
- 填入用户名和密码，点击登录

**未配置环境变量：**
- 使用 playwright-skill 打开浏览器
- 提示用户手动登录
- 等待用户确认登录完成后继续

### 3. 抓取任务详情

使用 playwright-skill 访问任务/Bug 页面，抓取以下字段：

| 字段 | 页面位置（参考） |
|------|------------------|
| 标题 | 页面标题或 `#mainContent .main-header` |
| 类型 | 任务类型字段 |
| 优先级 | 优先级字段 |
| 预计工时 | 预计工时字段 |
| 描述 | 任务描述/步骤 |
| 指派人 | 指派给字段 |
| 所属项目 | 所属项目字段 |
| 所属需求 | 相关需求链接 |
| 关联Bug | 相关 Bug 链接 |

**注意**：具体的 CSS 选择器需要根据实际页面结构调整，首次使用时请先截图分析页面结构。

### 4. 创建任务文档

调用 doc-writer skill 创建任务文档：

**输出位置**：`~/workspace/Knowledge-Library/02-Tasks/`

**文件名格式**：`yyyyMMdd-{zentao_id}-{title}.md`

**示例**：`20260118-T1234-用户登录优化.md`

### 5. 文档内容填充

将抓取的数据填充到任务模板：

```yaml
---
created: {当前日期}
updated: {当前日期}
project: {所属项目}
zentao_id: {T1234 或 B5678}
assignee: {指派人}
branch:
published: 未发布
deployed:
status: 进行中
tags:
  - type/task
---

# {任务标题}

## 任务信息

| 属性 | 值 |
|------|-----|
| 禅道ID | {zentao_id} |
| 类型 | {任务类型} |
| 优先级 | {优先级} |
| 预估工时 | {预计工时} |

## 问题描述

{任务描述内容}

## 分析

> 问题分析、原因定位

## 解决方案

> 技术方案、实现思路

## 实现步骤

- [ ] 步骤1
- [ ] 步骤2
- [ ] 步骤3

## 测试验证

- [ ] 单元测试
- [ ] 功能测试
- [ ] 回归测试

## 发布记录

| 环境 | 时间 | 状态 |
|------|------|------|
| dev | | |
| testc | | |
| pre | | |
| pro | | |

## 相关链接

- 禅道任务：https://chandao.bytenew.com/zentao/{task|bug}-view-{id}.html
- 相关需求：{如有}
- 关联Bug：{如有}
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 环境变量未配置 | 提示："未检测到 ZENTAO_USER/ZENTAO_PASSWORD 环境变量，将打开浏览器请手动登录" |
| 登录失败 | 提示："登录失败，请检查账号密码是否正确" |
| 任务不存在 | 提示："任务 {ID} 不存在，请检查任务 ID 是否正确" |
| 网络超时 | 提示："访问禅道超时，请检查网络连接" |
| 页面结构变化 | 提示："无法解析页面内容，页面结构可能已变化，请截图分析" |

## 依赖

- **playwright-skill**：用于浏览器自动化访问禅道
- **doc-writer skill**：用于按规范创建任务文档

## 使用示例

```
/zentao-sync T1234    — 同步任务 T1234
/zentao-sync B5678    — 同步 Bug B5678
```
