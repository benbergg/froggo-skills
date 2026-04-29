# 已知坑 / 反直觉行为

> 实测账号 qingwa（id=172），实测时间 2026-04-27。遇到反直觉行为先查这里。

## 必读速查

| 现象 | 真相 / 处理 |
|------|------------|
| `GET /tasks?limit=500` 只返回 1 条 | 顶层 `/tasks` 的 `limit`/`page` 失效，**禁用**；改走 `/executions/{id}/tasks`。`paginate` 函数内置安全阀（`p>20` 退出），但仍不应在顶层 `/tasks` 上用。 |
| `GET /products/{id}/bugs?status=resolved` 返回空 | 该参数破坏查询（任何值都返 total=0），**禁用**；用 jq 客户端筛。 |
| `?assignedTo=qingwa` 没效果 | API 几乎所有过滤参数都被忽略，统一改 jq 筛。 |
| `POST /tokens` 报"登录失败" | 检查请求体字段：API 要 **`account`**（不是 `username`）。`acquire_token` 已正确处理。 |
| 想拿"我的信息" | `GET /user`（**单数**），返回 profile + view 范围。`/users/me` 也存在但建议用 `/user`。 |
| 顶层 `/bugs` 报 "Need product id." | API 不支持，必须按产品查 `/products/{id}/bugs`。 |
| 调用返回 HTML / `<html>...` | 网络劫持或本地代理兜底。所有 curl 加 `--noproxy '*'`（lib 已默认）。 |
| Token 失效 | `zentao_call` 自动重取 + 重试 1 次。手动重置：`rm $ZENTAO_CACHE_DIR/token.json`。 |

## 实测白名单

| 参数 | 在哪些接口生效 |
|------|----------------|
| `limit` / `page` | 所有列表型端点 ✓；**唯独 `/tasks` 顶层失效** ✗ |
| `?status=` | `/executions` ✓；`/products/{id}/bugs` ✗（破坏） |

## 服务端筛选不可信

API v1 的服务端过滤参数除了 `/executions?status=` 之外几乎都不可信。设计上**强制改用客户端 jq 筛**，避免依赖服务端。

## 响应含未转义控制字符（已自动修复）

实测 2026-04-29：部分端点（如 `/executions/{id}/tasks`）的字符串字段（task name、备注等）会包含**未转义的控制字符** `\x01`-`\x08` `\x0b` `\x0c` `\x0e`-`\x1f`，导致严格 JSON 解析器（jq、Python `json`）整体 parse 失败 —— 但能取到部分顶层字段（jq 流式部分解析的副作用）。

`zentao_call` 内部已加 sanitize 步骤：用 `tr -d` 剥离非法控制字符，保留 `\t \n \r`。所以**走 `zentao_call` / `paginate` 拿到的响应可以直接 jq 整体解析**。

如果绕开 lib 直接 `curl` 命中端点，记得自己 sanitize：
```bash
curl ... | LC_ALL=C tr -d '\001-\010\013\014\016-\037'
```

## 老项目子端点返回空 body

实测 2026-04-29：`/projects/{id}/stories` 对老的关闭项目（`status=closed`）会返回**完全空 body**（不是 `{"stories":[]}`），导致 jq parse 失败。活跃 doing 项目则正常。

**应对**：用 `/executions?status=doing` 拿到的 project ID（活跃），避免直接遍历老 project ID。如果业务上必须遍历所有 project，先用 `[ -n "$resp" ]` 检查 body 非空。

## "由我关闭"视图陷阱（旧 zentao_browser 时代）

旧 skill 通过抓 `my-contribute-task.html` 的"由我关闭"视图，会拉到全量历史，需要二次筛。API 时代直接按 `finishedDate ∈ 本周` 在客户端筛，**没有此陷阱**。
