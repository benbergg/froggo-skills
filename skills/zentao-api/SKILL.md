---
name: zentao-api
description: "Zentao RESTful API v1: query users, products, projects, executions, stories, tasks, bugs (read); create tasks and sub-tasks (write). DELETE is NOT supported by design. 禅道API、禅道查询、查任务、查Bug、查需求、查产品、查项目、查迭代、本周完成、待跟进Bug、创建任务、创建子任务、zentao API"
---

# Zentao API

通过禅道 RESTful API v1 查询数据 + **有限写入**（仅创建任务 / 子任务）。
**严格禁止删除**：lib 不提供任何 DELETE 函数，单个 / 批量删除均不支持。

## When to Use

触发关键词：禅道、zentao API、查任务、查 Bug、查需求、查产品、查项目、查迭代、本周完成的任务、本周解决的 Bug、待跟进 Bug、下周待开展任务、**创建任务**、**创建子任务**。

**支持的写入操作**：
- Task：创建 / 创建子任务 / 修改 / 开始 / 暂停 / 继续 / 完成 / 关闭 / 添加工时日志
- Bug：创建 / 修改 / 确认 / 关闭 / 激活 / 解决（**Bug 备注通过这些 action 端点的 `comment` 字段附加**）

**不支持**：
- ❌ DELETE（任何形式的单 / 批量删除，设计层面禁止；lib 无任何 `*delete*` 函数，bats 测试锁定）
- ❌ Bug 单独加备注（v1/v2 RESTful API 无独立端点，曲线方案见 `references/known-issues.md`）
- ❌ 网页 UI 操作 / HTML 抓取（已废弃）

## 环境变量（必读）

| 变量 | 必填 | 说明 |
|------|------|------|
| `ZENTAO_BASE_URL` | ✓ | 例如 `https://chandao.bytenew.com/zentao/api.php/v1` |
| `ZENTAO_ACCOUNT` | ✓ | 登录账号 |
| `ZENTAO_PASSWORD` | ✓ | 密码 |
| `ZENTAO_ME` | – | jq 筛 `.account == $me` 用，缺省取 `/user.profile.account` |
| `ZENTAO_CACHE_DIR` | – | 缺省 `${XDG_CACHE_HOME:-~/.cache}/zentao` |

未设置必填项时 `acquire_token` 会报 `FATAL: missing required env: ...` 并退出。

## Quick Start

```bash
source skills/zentao-api/lib/zentao.sh

# 一次性接口
zentao_call /user                       # 我的 profile + view 范围
zentao_call /products                   # 产品列表
zentao_call /executions?status=doing    # 进行中的迭代

# 列表分页（自动翻页到 total 收敛或 page=20 安全阀）
paginate /products/131/bugs

# 周报口径
compute_week_range                      # 导出 WK_START / WK_END / NEXT_S / NEXT_E
```

## 核心函数（详细契约见 `lib/zentao.sh`）

**读：**

| 函数 | 签名 | 说明 |
|------|------|------|
| `acquire_token` | `acquire_token` → stdout: token | POST `/tokens`，写 `$cache/token.json` 权限 600 |
| `zentao_call` | `zentao_call <ep>` → stdout: body | GET，401 自动重取 + 重试 1 次 |
| `paginate` | `paginate <ep>` → stdout: pages 拼接 | `?limit=500&page=N` 循环；`p>20` 安全阀；不可用于顶层 `/tasks` |
| `get_user_cached` | `get_user_cached` → stdout: user JSON | 24h TTL 文件缓存 |
| `compute_week_range` | `compute_week_range` → exports vars | 周一 00:00 ~ 下周一 00:00 UTC（与 weekly_report 口径一致） |

**写 — 通用：**

| 函数 | 签名 | 说明 |
|------|------|------|
| `zentao_post` | `<ep> <body_json>` → body | 通用 POST，401 自动重取 |
| `zentao_put` | `<ep> <body_json>` → body | 通用 PUT，401 自动重取 |

**写 — Task 生命周期（v1 §2.13）：**

| 函数 | 端点 | body 必填（文档） | 备注 |
|------|------|----------------|------|
| `zentao_create_task <eid> <body>` | `POST /executions/{eid}/tasks` | name, estStarted, deadline | parent 字段在 POST 被忽略 |
| `zentao_create_subtask <eid> <pid> <body>` | POST + PUT | 同上 | 自动两步流程：先创建后设 parent |
| `zentao_update_task <id> [body]` | `PUT /tasks/{id}` | — | 修改 module/story/name/type/assignedTo/pri/estimate/estStarted/deadline |
| `zentao_start_task <id> [body]` | `POST /tasks/{id}/start` | left | wait → doing |
| `zentao_pause_task <id> [body]` | `POST /tasks/{id}/pause` | — | doing → pause；body 可含 comment |
| `zentao_resume_task <id> [body]` | `POST /tasks/{id}/restart` | left（**实测还要 consumed**） | pause → doing；端点是 `/restart` 不是 `/resume` |
| `zentao_finish_task <id> [body]` | `POST /tasks/{id}/finish` | currentConsumed, finishedDate | → done |
| `zentao_close_task <id> [body]` | `POST /tasks/{id}/close` | — | done → closed |
| `zentao_create_task_log <id> <body>` | `POST /tasks/{id}/estimate` | date[], work[], consumed[], left[]（并行数组） | 添加工时日志 |
| `zentao_get_task_logs <id>` | `GET /tasks/{id}/estimate` | — | 取工时日志 |

**写 — Bug 生命周期（v1 §2.14）：**

| 函数 | 端点 | body 必填 | 备注 |
|------|------|---------|------|
| `zentao_create_bug <pid> <body>` | `POST /products/{pid}/bugs` | title, severity, pri, type | type ∈ codeerror/config/install/security/performance/standard/automation/designdefect/others |
| `zentao_update_bug <id> [body]` | `PUT /bugs/{id}` | — | 修改 15 字段 |
| `zentao_confirm_bug <id> [body]` | `POST /bugs/{id}/confirm` | — | body 可含 comment |
| `zentao_close_bug <id> [body]` | `POST /bugs/{id}/close` | — | body 可含 comment |
| `zentao_activate_bug <id> [body]` | `POST /bugs/{id}/active` | — | 端点是 `/active` 不是 `/activate`；body 可含 comment |
| `zentao_resolve_bug <id> <body>` | `POST /bugs/{id}/resolve` | resolution | resolution ∈ bydesign/duplicate/external/fixed/notrepro/postponed/willnotfix/tostory；body 可含 comment |

**无 DELETE 函数**：本 lib 不提供任何 `zentao_delete*` / `zentao_remove*` 函数。bats 测试 `no DELETE helper` 多处断言锁定此约束。

### 创建子任务示例

```bash
source skills/zentao-api/lib/zentao.sh

# 1. 创建一个顶层 task
zentao_create_task 3292 '{
  "name": "重构积分计算模块",
  "type": "devel",
  "assignedTo": "qingwa",
  "estStarted": "2026-04-29",
  "deadline": "2026-05-06",
  "estimate": 8
}'
# → {"id":43906,...}

# 2. 在已有 task 下创建子任务
zentao_create_subtask 3292 43906 '{
  "name": "积分增减接口",
  "type": "devel",
  "assignedTo": "qingwa",
  "estStarted": "2026-04-29",
  "deadline": "2026-04-30",
  "estimate": 2
}'
# → 返回设好 parent 的 task JSON
```

## 渐进式深读

按需打开下列子文档，避免一次性把所有信息塞进上下文：

| 何时读 | 文件 |
|--------|------|
| 想知道某种数据该调哪个端点 | [`references/endpoints.md`](references/endpoints.md) — 完整端点目录 + 调用依赖图 |
| 写"我的任务/Bug"等周报口径 | [`references/recipes.md`](references/recipes.md) — R1~R5 jq 模板 |
| 遇到反直觉行为（顶层 /tasks 残废、status= 破坏 bugs 查询等） | [`references/known-issues.md`](references/known-issues.md) |
| 部署后端到端验证 | [`references/smoke-test.md`](references/smoke-test.md) |

## 安全约束

- **禁止 DELETE**：lib 不提供任何 DELETE 函数；不允许任何形式的单个 / 批量删除。这是硬约束，bats 测试断言锁定。
- **写操作仅限创建任务**：`zentao_create_task` / `zentao_create_subtask` / 底层 `zentao_post` `zentao_put`。其他写操作（创建/修改 Bug、关闭/解决 等）当前 skill **未实现**，需要时按 `references/endpoints.md` 列出的端点扩展。
- **token 不入日志**：`token.json` 与 `user.json` 文件权限 600；`$cache` 目录 700。
- **不绕过 noproxy**：所有 curl 加 `--noproxy '*'`，避免本机代理（Clash/Surge）兜底返回 HTTP 400。

## 测试

```bash
bats tests/zentao-api/        # 全部单元测试（mock curl，无网络）
```

Live API 烟雾测试需手动跑，见 `references/smoke-test.md`。
