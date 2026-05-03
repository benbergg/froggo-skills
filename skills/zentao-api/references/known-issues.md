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

## Bug 加备注：无独立端点，须借 action 端点附带

实测 + 官方文档确认（[v1 索引](https://www.zentao.net/book/api/665.html) §2.14、[修改 Bug 723](https://www.zentao.net/book/api/723.html)）：

- v1 bug 章节 9 个端点（`720`/`721`/`722`/`723`/`724`/`1120`/`1121`/`1142`/`1181`）**没有「添加备注/评论」独立端点**
- v2 bug 章节 10 个端点也没有
- 「修改 Bug」（`PUT /bugs/{id}`）请求体 15 个字段中**没有 `comment` 字段**

**但**：`confirm` / `close` / `activate` / `resolve` 这 4 个 bug action 端点的 body 都接受 `comment` 字段。这是禅道 v1 的设计哲学 —— **备注是状态变更的副产品**，不是独立操作。

**实用曲线方案**：

```bash
# 想"只加备注不改状态"在 v1 不可行；最接近的做法：
# 用 confirm + comment（如果 bug 已 confirmed，再 confirm 一次幂等且不改状态语义）
zentao_confirm_bug 52912 '{"comment":"已联系产品确认需求边界"}'

# 或：解决/关闭时附带备注（推荐用法 —— 备注本来就该和状态变更一起）
zentao_resolve_bug 52912 '{"resolution":"fixed","comment":"PR #42 修复"}'
zentao_close_bug 52912 '{"comment":"复测通过"}'
```

如果业务上必须"加备注但完全不动状态"，只能通过 UI 或非 v1 老路由（`/index.php?m=action&f=createComment`，需要 cookie session，超出本 skill 范围）。

## resume_task 实测必填 `consumed`（文档与实际不符）

[zentao.net/book/api/969.html](https://www.zentao.net/book/api/969.html) 文档说 `POST /tasks/{id}/restart` 只有 `left` 必填。实测当前禅道实例（chandao.bytenew.com）调用时：

```
{"error":"『总计消耗』不能为空。"}
```

需要同时传 `consumed`：

```bash
zentao_resume_task 43909 '{"left":1,"consumed":2,"comment":"continue"}'
```

`zentao_resume_task` 函数本身不强制此字段（保持与文档一致 + 不绑定具体禅道版本），由调用方按实际错误信息补齐。

## 创建子任务必须两步：POST + PUT

实测发现：`POST /executions/{eid}/tasks` 创建 task 时 **无论是否传 `parent` 字段，响应里 `parent` 都是 0**，子任务关联未生效。必须紧接着 `PUT /tasks/{newId}` body `{"parent": <parentId>}` 才真正建立父子关系。

`zentao_create_subtask` 函数已封装这个两步流程，并主动从 POST body 中剥除 `parent` 字段，避免误用。

## 老项目子端点返回空 body

实测 2026-04-29：`/projects/{id}/stories` 对老的关闭项目（`status=closed`）会返回**完全空 body**（不是 `{"stories":[]}`），导致 jq parse 失败。活跃 doing 项目则正常。

**应对**：用 `/executions?status=doing` 拿到的 project ID（活跃），避免直接遍历老 project ID。如果业务上必须遍历所有 project，先用 `[ -n "$resp" ]` 检查 body 非空。

## "由我关闭"视图陷阱（旧 zentao_browser 时代）

旧 skill 通过抓 `my-contribute-task.html` 的"由我关闭"视图，会拉到全量历史，需要二次筛。API 时代直接按 `finishedDate ∈ 本周` 在客户端筛，**没有此陷阱**。

## 11. 官方文档 vs 生产实例差异汇总表

> **必读** — 通用 LLM 训练语料只见过禅道官方文档(664/665),会按文档写出错误的 URL/方法/字段。
>
> **证据来源说明**:
> - `已实测 ✓` — 本文件其他章节已明确记录的实测偏差
> - `lib 推断` — V2 `lib/zentao.sh` 这么用,但未直接抓包验证。需 Phase 5 verify.md 确认
> - `待 V3 验证` — 偏差猜测,Phase 5 必须实测后回填

| 操作 | 官方文档 (664/665) | 实际行为 | 证据来源 |
|------|-------------------|----------|---------|
| 获取 Token | `GET /token` | `POST /tokens`(body:`{account,password}`) | **已实测 ✓** |
| 创建任务 | `POST /tasks` | `POST /executions/{eid}/tasks` | **已实测 ✓** |
| 任务-继续 | `PUT /tasks/{id}/continue` | `POST /tasks/{id}/restart`(实测还要 `consumed`) | **已实测 ✓** |
| 任务日志 | `POST/GET /tasks/{id}/logs` | `POST/GET /tasks/{id}/estimate` | **已实测 ✓** |
| 激活 Bug | `PUT /bugs/{id}/activate` | `POST /bugs/{id}/active` | **已实测 ✓** |
| 任务 start/pause/finish/close 方法 | 文档标 PUT | V2 lib 用 POST | `lib 推断` → 待 V3 verify 确认 |
| Bug confirm/close/resolve 方法 | 文档标 PUT | V2 lib 用 POST | `lib 推断` → 待 V3 verify 确认 |
| 用例端点路径 | `/cases` | V2 endpoints.md 写 `/products/{id}/testcases` | `lib 推断` → 待 V3 verify 确认 |
| 测试单端点路径 | `/testsuites` | V2 endpoints.md 写 `/products/{id}/testtasks` | `lib 推断` → 待 V3 verify 确认 |

> **Phase 5 强制要求**:`verify.md` L5 必须对每条 `lib 推断` 行抓包(`curl -v`)确认实际请求/响应,把结果回填本表,把列名改回"实测"+真实日期。
