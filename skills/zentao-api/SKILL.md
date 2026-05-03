---
name: zentao-api
description: "Zentao RESTful API v1 (读+写,无 DELETE)。读:user/product/project/execution/story/task/bug/build/release/plan/feedback/ticket。写:Task 全生命周期(create/update/start/pause/restart/finish/close/effort log)、Bug 全生命周期(create/update/confirm/close/active/resolve)、Story(create/update/change/close)。禅道API、zentao、查/创建/修改/开始/暂停/继续/完成/关闭任务、查/创建/修改/解决/确认/激活/关闭Bug、查/创建/变更/关闭需求、查产品、查项目、查迭代、查执行、查用户、查版本、查发布、查计划、查反馈、查工单"
---

# Zentao API

通过禅道 RESTful API v1 进行**读 + 受控写**。**严格禁止删除**:本 skill 不暴露任何 DELETE 端点。

## When to Use

触发关键词:禅道、zentao API、查/创建/修改/解决任务、查/创建/解决/确认 Bug、查/创建/变更需求、查迭代、查产品、查项目、查用户、查版本…

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `ZENTAO_BASE_URL` | ✓ | 例 `https://chandao.bytenew.com/zentao/api.php/v1` |
| `ZENTAO_ACCOUNT`  | ✓ | 登录账号 |
| `ZENTAO_PASSWORD` | ✓ | 密码 |
| `ZENTAO_ME`       | – | 缺省取 `/user.profile.account` |
| `ZENTAO_CACHE_DIR`| – | 缺省 `${XDG_CACHE_HOME:-~/.cache}/zentao` |

## 必读调用模板

完整 6 个 bash snippet 在 [`references/auth-and-curl.md`](references/auth-and-curl.md)。**任何调用前必须先复制全部 snippet 并 eval**:

```bash
# 把 references/auth-and-curl.md 中的 S1-S6 snippet 全部复制到当前 shell
zt_init && zt_acquire_token >/dev/null
zt_get /user | jq .profile.account
zt_get '/executions?status=doing&limit=10'
zt_paginate '/executions/3292/tasks'
zt_write POST '/executions/3292/tasks' '{"name":"x","estStarted":"2026-05-04","deadline":"2026-05-06"}'
zt_write PUT  '/tasks/43906' '{"parent":43901}'   # 创建子任务的第二步
```

## 依赖图概览(完整版见 [`references/endpoints.md`](references/endpoints.md))

```
入口:  /user /users /departments /programs /products /projects
       /executions /productplans /testtasks /feedbacks /tickets

二级:
  product → /products/{id}/{stories|bugs|plans|releases|cases}
  project → /projects/{id}/{stories|bugs|executions|builds|releases|testtasks}
  exec    → /executions/{id}/{stories|tasks|bugs|builds}    ★ tasks 唯一来源
  plan    → /productplans/{id}/{stories|bugs}
  program → /programs/{id}/{products|projects}
```

## 写入端点字段速查

| 操作 | 端点 | 必填 body 字段 | 备注 |
|------|------|--------------|------|
| 创建任务 | `POST /executions/{eid}/tasks` | name, estStarted, deadline | parent 字段被忽略 |
| 创建子任务 | 上 + `PUT /tasks/{newId}` body `{parent}` | 同上 + 第二步 parent | 必须两步 |
| 修改任务 | `PUT /tasks/{id}` | — | 修改 module/story/name/type/assignedTo/pri/estimate/estStarted/deadline |
| 开始任务 | `POST /tasks/{id}/start` | left | wait → doing |
| 暂停任务 | `POST /tasks/{id}/pause` | — | doing → pause;body 可含 comment |
| 继续任务 | `POST /tasks/{id}/restart` | left + (实测) consumed | pause → doing;⚠ 端点是 /restart 不是 /continue |
| 完成任务 | `POST /tasks/{id}/finish` | currentConsumed, finishedDate | → done |
| 关闭任务 | `POST /tasks/{id}/close` | — | done → closed |
| 添加工时日志 | `POST /tasks/{id}/estimate` | date[], work[], consumed[], left[] (并行数组) | ⚠ 端点是 /estimate 不是 /logs |
| 创建 Bug | `POST /products/{pid}/bugs` | title, severity, pri, type | type ∈ codeerror/config/install/security/performance/standard/automation/designdefect/others |
| 修改 Bug | `PUT /bugs/{id}` | — | 修改 15 字段 |
| 确认 Bug | `POST /bugs/{id}/confirm` | — | body 可含 comment |
| 关闭 Bug | `POST /bugs/{id}/close` | — | body 可含 comment |
| 激活 Bug | `POST /bugs/{id}/active` | — | ⚠ 端点是 /active 不是 /activate |
| 解决 Bug | `POST /bugs/{id}/resolve` | resolution | resolution ∈ bydesign/duplicate/external/fixed/notrepro/postponed/willnotfix/tostory |
| 创建需求 | `POST /stories` | product, title | 字段细节见 [`references/endpoints.md`](references/endpoints.md) §2.7 |
| 变更需求 | `PUT /stories/{id}/change` | spec, verify | 详见 endpoints.md |
| 关闭需求 | `PUT /stories/{id}/close` | reason | reason ∈ done/cancel/postponed/... |

## 渐进式深读

| 何时读 | 文件 |
|--------|------|
| 调用前必看(token/curl/分页) | [`references/auth-and-curl.md`](references/auth-and-curl.md) |
| 想知道某种数据该调哪个端点 | [`references/endpoints.md`](references/endpoints.md) |
| 写聚合查询(跨执行/跨产品/父子) | [`references/patterns.md`](references/patterns.md) |
| 遇到反直觉行为(顶层 /tasks 残废、/active vs /activate 等) | [`references/known-issues.md`](references/known-issues.md) |
| 部署后/换实例后端到端验证 | [`references/verify.md`](references/verify.md) |

## 硬约束

- **禁止 DELETE**:本 skill 不暴露任何 DELETE 端点。设计层面禁止单 / 批量删除。
- **必加 `--noproxy '*'`**:本机代理(Clash/Surge)兜底返回 HTTP 400,所有 curl 都要 `--noproxy '*'`(snippet 已默认)。
- **必 sanitize**:`tr -d '\000-\010\013\014\016-\037'`(删 NUL + 控制字符,**保留** `\t \n \r`),否则严格 JSON 解析失败 + NUL 截断 bash 命令替换。snippet 已默认。
- **token 不入日志**:`token.json` 文件权限 600;`$cache` 目录 700。snippet 已默认。
- **顶层 `/tasks` 禁用**:`limit/page` 失效,必走 `/executions/{id}/tasks`。
