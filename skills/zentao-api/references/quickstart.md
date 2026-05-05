# Quickstart — Zentao API v1

> 5 步上手 + env 详表 + 自检命令。函数实现在 [`../scripts/zt-functions.sh`](../scripts/zt-functions.sh)。

## Prerequisites

- bash >= 4
- curl
- jq
- macOS（BSD `date`）或 Linux（GNU `date`），S6 已做兼容

## Environment Variables

| 变量 | 必填 | 说明 |
|------|------|------|
| `ZENTAO_BASE_URL` | ✓ | 例 `https://chandao.bytenew.com/zentao/api.php/v1` |
| `ZENTAO_ACCOUNT`  | ✓ | 登录账号 |
| `ZENTAO_PASSWORD` | ✓ | 密码 |
| `ZENTAO_ME`       | – | 缺省取 `/user.profile.account` |
| `ZENTAO_CACHE_DIR`| – | 缺省 `${XDG_CACHE_HOME:-~/.cache}/zentao` |

## Loading the Function Library

**推荐方式**：source 到当前 shell

```bash
source /path/to/skills/zentao-api/scripts/zt-functions.sh
```

**等效方式**：把 `scripts/zt-functions.sh` 全部内容粘贴到当前 shell 后回车。

## 5-Step Quick Start

```bash
# 1. 设置 env（详表见上）
export ZENTAO_BASE_URL="https://chandao.bytenew.com/zentao/api.php/v1"
export ZENTAO_ACCOUNT="your_account"
export ZENTAO_PASSWORD="your_password"

# 2. source 函数库
source /path/to/skills/zentao-api/scripts/zt-functions.sh

# 3. 校验环境 + 取 token
zt_init && zt_acquire_token >/dev/null

# 4. 调用
zt_get /user | jq .profile.account
zt_get '/executions?status=doing&limit=10'
zt_paginate '/executions/3292/tasks'
zt_write POST '/executions/3292/tasks' \
  '{"name":"x","assignedTo":"qingwa","estStarted":"2026-05-04","deadline":"2026-05-06"}'
zt_write PUT '/tasks/43906' '{"parent":43901}'  # 创建子任务的第二步

# 5. 自检（参见下节）
```

## Function Reference (S1-S6)

| ID | 函数 | 一句话职责 |
|----|------|----------|
| S1 | `zt_init` | 校验三个必填 env + 准备缓存目录(700 权限) |
| S2 | `zt_acquire_token` | POST /tokens 取 token，写 600 权限 token.json |
| S3 | `zt_get` | GET 包装，含 sanitize（`tr -d '\000-\037'`）+ 401 自动重取 |
| S4 | `zt_write` | POST/PUT 包装，同 sanitize + 401 重取 |
| S5 | `zt_paginate` | `?limit=500&page=N` 循环 + 20 页安全阀 |
| S6 | `zt_week_range` | 周一 00:00 ~ 下周一 00:00 UTC（BSD/GNU date 兼容） |

> 安全约束（`--noproxy '*'` / `tr -d '\000-\037'` / chmod 600 700）的**原理**详见 [`troubleshooting.md`](troubleshooting.md) `## Quick Lookup` 与 `## Control-Char-in-Response Already Handled`。

## Self-Check

```bash
zt_init && echo "✓ env OK"
zt_acquire_token >/dev/null && echo "✓ token OK"
zt_get /user | jq -e .profile.account >/dev/null && echo "✓ /user OK"
zt_week_range && echo "WK_START=$WK_START WK_END=$WK_END"
```

更全面的端到端验证（部署后/换实例后）见 [`verify.md`](verify.md) L0-L6。
