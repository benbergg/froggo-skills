# 禅道 API 端点目录

> 本文件按需载入。先看 `SKILL.md` 主文件再读这里。

## 调用依赖图

```
入口（无前置 ID）：
  /user      /users     /programs    /products    /projects    /executions

二级（需要上层 ID）：
  program → /programs/{id}/{products|projects}
  product → /products/{id}/{plans|stories|bugs|projects|testcases|testtasks}
  project → /projects/{id}/{stories|bugs|executions|builds}
  exec    → /executions/{id}/{stories|tasks|bugs|builds}        ★ tasks 唯一来源

详情：
  /programs/{id}  /products/{id}  /projects/{id}  /executions/{id}
  /users/{id}  /stories/{id}  /tasks/{id}  /bugs/{id}
```

⚠️ 残废端点（API 存在但不可用）：
- 顶层 `GET /tasks` — `limit`/`page` 失效，永远只返 1 条 → **禁用**，必须走 `/executions/{id}/tasks`
- `GET /products/{id}/bugs?status=...` — `status` 参数破坏查询（任何值都返 0）→ **不要传 status**

## "已知什么" → "调什么"

| 已知 | 想要 | 调用 |
|------|------|------|
| 什么都不知道 | "我的"数据 | `/user` 拿 view 范围 |
| 什么都不知道 | 大盘 | `/products` / `/projects` / `/executions` |
| productId | 需求/Bug/计划/项目/用例/测试单 | `/products/{id}/{stories\|bugs\|plans\|projects\|testcases\|testtasks}` |
| projectId | 需求/Bug/迭代/版本 | `/projects/{id}/{stories\|bugs\|executions\|builds}` |
| executionId | 任务/需求/Bug/版本 | `/executions/{id}/{tasks\|stories\|bugs\|builds}` |
| programId | 产品/项目 | `/programs/{id}/{products\|projects}` |
| taskId/bugId/storyId/userId | 详情 | 对应详情端点 |

## 用户

| 用途 | 调用 |
|------|------|
| 我的 profile + view（含可见 sprints/products/projects/programs ID 列表） | `zentao_call /user`（**单数**） |
| 用户列表 | `zentao_call /users` |
| 用户详情 | `zentao_call /users/{id}` |

## 产品

| 用途 | 调用 |
|------|------|
| 列表 / 详情 | `zentao_call /products` / `zentao_call /products/{id}` |
| 产品计划 | `zentao_call /products/{id}/plans` |
| 产品需求 | `zentao_call /products/{id}/stories` |
| 产品 Bug | `zentao_call /products/{id}/bugs`（**不要带 status**） |
| 产品参与的项目 | `zentao_call /products/{id}/projects` |
| 用例 / 测试单 | `zentao_call /products/{id}/{testcases\|testtasks}` |

## 项目集 / 项目 / 执行

| 用途 | 调用 |
|------|------|
| 项目集列表 / 详情 | `zentao_call /programs` / `zentao_call /programs/{id}` |
| 项目集子集 | `zentao_call /programs/{id}/{products\|projects}` |
| 项目列表 / 详情 | `zentao_call /projects` / `zentao_call /projects/{id}` |
| 项目子集 | `zentao_call /projects/{id}/{stories\|bugs\|executions\|builds}` |
| 执行（**支持 status=doing**） | `zentao_call "/executions?status=doing&limit=500"` |
| 执行详情 | `zentao_call /executions/{id}` |
| 执行子集 ★ tasks 必经路径 | `zentao_call /executions/{id}/{stories\|tasks\|bugs\|builds}` |

## 详情

| 用途 | 调用 |
|------|------|
| 需求详情 | `zentao_call /stories/{id}` |
| 任务详情 | `zentao_call /tasks/{id}` |
| Bug 详情 | `zentao_call /bugs/{id}` |

## 通用查询参数（实测白名单）

| 参数 | 在哪些接口生效 |
|------|----------------|
| `limit` / `page` | 所有列表型端点 ✓；**唯独 `/tasks` 顶层失效** ✗ |
| `?status=` | `/executions` ✓；`/products/{id}/bugs` ✗（破坏查询） |
| `?assignedTo=` `?openedBy=` `?resolvedBy=` 等 | ✗ 大部分被忽略，统一改 jq 客户端筛 |

## 高频调用链

| 业务场景 | 调用链 |
|----------|--------|
| 本周我完成的任务 | `/user` → `view.sprints ∩ /executions?status=doing` → 遍历 `/executions/{sid}/tasks` → jq 筛 `finishedBy=me` |
| 本周我解决的 Bug | `/user` → 遍历 `view.products` → `/products/{pid}/bugs` → jq 筛 `resolvedBy=me` |
| 下周待开展任务 | 同"本周任务"，jq 筛 `assignedTo=me` & `deadline ∈ 下周` & `status ∈ {wait,doing}` |
| 待跟进 Bug | 同"本周 Bug"，jq 筛 `assignedTo=me` & `status="active"` |
| 任务 + 父任务 | `/tasks/{tid}` → `.parent` → `/tasks/{parent}` |
