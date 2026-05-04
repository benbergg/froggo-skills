# 已知坑 / 反直觉行为

> 实测账号 qingwa（id=172），实测时间 2026-04-27。遇到反直觉行为先查这里。

## 必读速查

| 现象 | 真相 / 处理 |
|------|------------|
| `GET /tasks?limit=500` 只返回 1 条 | 顶层 `/tasks` 的 `limit`/`page` 失效，**禁用**；改走 `/executions/{id}/tasks`。`zt_paginate` 内置安全阀（`p>20` 退出），但仍不应在顶层 `/tasks` 上用。 |
| `GET /executions/{id}/tasks` 拉不到子任务 | **list 端点默认只展开父任务+顶层任务,子任务藏在父对象 `.children[]` 子数组**(详见 §11.2)。jq 必须递归 `[.tasks[]?]+[.tasks[]?.children[]?]`;漏 children 等于漏 60%+ 真实任务。 |
| `GET /products/{id}/bugs` 拉不到历史 closed bug | **默认隐式过滤 `status != closed`**(详见 §11.3),total 只反映"活跃" bug。需要历史:加 `?status=all`(实测 total 从 34 → 1115)。 |
| `GET /products/{id}/bugs?status=resolved` 返回空 | 单值 status 参数(resolved/closed/...)破坏查询(返 total=0)。**唯一可用值是 `?status=all`**,其他不要传。 |
| `?assignedTo=qingwa` 没效果 | API 几乎所有过滤参数都被忽略,统一改 jq 筛。 |
| `POST /tokens` 报"登录失败" | 检查请求体字段：API 要 **`account`**（不是 `username`）。`zt_acquire_token` 已正确处理。 |
| 想拿"我的信息" | `GET /user`（**单数**），返回 profile + view 范围。`/users/me` 也存在但建议用 `/user`。 |
| 顶层 `/bugs` 报 "Need product id." | API 不支持，必须按产品查 `/products/{id}/bugs`。 |
| 调用返回 HTML / `<html>...` | 网络劫持或本地代理兜底。所有 curl 加 `--noproxy '*'`（lib 已默认）。 |
| Token 失效 | `zt_get` / `zt_write` 自动重取 + 重试 1 次。手动重置：`rm $ZT_CACHE/token.json`。 |

## 实测白名单

| 参数 | 在哪些接口生效 |
|------|----------------|
| `limit` / `page` | 所有列表型端点 ✓；**唯独 `/tasks` 顶层失效** ✗ |
| `?status=` | `/executions` ✓(支持 doing/closed/all 等);`/products/{id}/bugs` **只接受 `all`**(其他值返空,默认值过滤 closed) |

## 服务端筛选不可信

API v1 的服务端过滤参数除了 `/executions?status=` 之外几乎都不可信。设计上**强制改用客户端 jq 筛**，避免依赖服务端。

## 响应含未转义控制字符（已自动修复）

实测 2026-04-29：部分端点（如 `/executions/{id}/tasks`）的字符串字段（task name、备注等）会包含**未转义的控制字符** `\x01`-`\x08` `\x0b` `\x0c` `\x0e`-`\x1f`，导致严格 JSON 解析器（jq、Python `json`）整体 parse 失败 —— 但能取到部分顶层字段（jq 流式部分解析的副作用）。

`zt_get` / `zt_write` 内部已加 sanitize 步骤：用 `tr -d` 剥离非法控制字符，保留 `\t \n \r`。所以**走 `zt_get` / `zt_write` / `zt_paginate` 拿到的响应可以直接 jq 整体解析**。

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
zt_write POST /bugs/52912/confirm '{"comment":"已联系产品确认需求边界"}'

# 或：解决/关闭时附带备注（推荐用法 —— 备注本来就该和状态变更一起）
zt_write POST /bugs/52912/resolve '{"resolution":"fixed","comment":"PR #42 修复"}'
zt_write POST /bugs/52912/close   '{"comment":"复测通过"}'
```

如果业务上必须"加备注但完全不动状态"，只能通过 UI 或非 v1 老路由（`/index.php?m=action&f=createComment`，需要 cookie session，超出本 skill 范围）。

## resume_task 实测必填 `consumed`（文档与实际不符）

[zentao.net/book/api/969.html](https://www.zentao.net/book/api/969.html) 文档说 `POST /tasks/{id}/restart` 只有 `left` 必填。实测当前禅道实例（chandao.bytenew.com）调用时：

```
{"error":"『总计消耗』不能为空。"}
```

需要同时传 `consumed`：

```bash
zt_write POST /tasks/43909/restart '{"left":1,"consumed":2,"comment":"continue"}'
```

V3 `zt_write` 不做字段级校验（保持与文档一致 + 不绑定具体禅道版本），由调用方按实际错误信息补齐 `consumed`。

## 创建子任务必须两步：POST + PUT

实测发现：`POST /executions/{eid}/tasks` 创建 task 时 **无论是否传 `parent` 字段，响应里 `parent` 都是 0**，子任务关联未生效。必须紧接着 `PUT /tasks/{newId}` body `{"parent": <parentId>}` 才真正建立父子关系。

V3 不再封装 `create_subtask` 函数，调用方直接两步：

```bash
# 1. 创建顶层 task（parent 字段被忽略，可不传）
NEW_ID=$(zt_write POST "/executions/$EXEC_ID/tasks" \
  '{"name":"sub-task","estStarted":"2026-05-04","deadline":"2026-05-06"}' \
  | jq -r '.id')

# 2. 设父子关系
zt_write PUT "/tasks/$NEW_ID" "$(jq -cn --argjson p "$PARENT_ID" '{parent:$p}')"
```

## 老项目子端点返回空 body

实测 2026-04-29：`/projects/{id}/stories` 对老的关闭项目（`status=closed`）会返回**完全空 body**（不是 `{"stories":[]}`），导致 jq parse 失败。活跃 doing 项目则正常。

**应对**：用 `/executions?status=doing` 拿到的 project ID（活跃），避免直接遍历老 project ID。如果业务上必须遍历所有 project，先用 `[ -n "$resp" ]` 检查 body 非空。

## "由我关闭"视图陷阱（旧 zentao_browser 时代）

旧 skill 通过抓 `my-contribute-task.html` 的"由我关闭"视图，会拉到全量历史，需要二次筛。API 时代直接按 `finishedDate ∈ 本周` 在客户端筛，**没有此陷阱**。

## 11. 官方文档 vs 生产实例差异汇总表

> **必读** — 通用 LLM 训练语料只见过禅道官方文档(664/665),会按文档写出错误的 URL/方法/字段。
>
> **证据来源说明**:全表 `已实测 ✓` 均经 V3 Phase 5 verify.md L0–L5 在 chandao.bytenew.com 实测确认(2026-05-04)。

| 操作 | 官方文档 (664/665) | 实际行为 | 证据来源 |
|------|-------------------|----------|---------|
| 获取 Token | `GET /token` | `POST /tokens`(body:`{account,password}`) | **已实测 ✓** |
| 创建任务 | `POST /tasks` | `POST /executions/{eid}/tasks`,**`assignedTo` 必填**(否则 `『指派给』不能为空`) | **已实测 ✓ 2026-05-04** |
| 任务-继续 | `PUT /tasks/{id}/continue` | `POST /tasks/{id}/restart`(实测还要 `consumed`) | **已实测 ✓** |
| 任务日志 | `POST/GET /tasks/{id}/logs` | `POST/GET /tasks/{id}/estimate` | **已实测 ✓** |
| 激活 Bug | `PUT /bugs/{id}/activate` | `POST /bugs/{id}/active` | **已实测 ✓** |
| 任务 start/pause/finish/close 方法 | 文档标 PUT | **POST 真改状态;PUT 返 200 + Content-Length: 0 但状态不变(静默 no-op)**。误用 PUT 无任何错误信号,数据零变更。V2 lib 选 POST 正确 | **L5.1 实测 `/start` ✓ 2026-05-04**(43927 wait→doing POST / 43928 wait→wait PUT)。pause/finish/close 基于 Zentao 同一 action route handler 对称性推断,未单独测;若怀疑回归用同款 POST/PUT 双任务对照法 |
| Bug confirm/close/resolve/active 方法 | 文档标 PUT | **同上,POST 真改 / PUT 静默 no-op** | **L5.2 实测 `/resolve` ✓ 2026-05-04**(53086 active→resolved POST / 53087 active→active PUT)。confirm/close/active 同上对称性推断,未单独测 |
| 用例端点路径 | `/cases` | `/products/{id}/testcases` 返 JSON ✓;`/products/{id}/cases` 返 `{"error":"not found"}` | **已实测 ✓ 2026-05-04** L5.3 |
| 测试单端点路径 | `/testsuites` | `/testtasks` 顶层可用 ✓;`/testsuites` 顶层报 `Need product id.`,需走 `/products/{id}/testsuites` | **已实测 ✓ 2026-05-04** L5.4 |
| 任务 close 副作用 | 文档未提 | **`assignedTo` 被清成 `null`**,`finishedBy`/`closedBy` 保留。基于 assignedTo 的客户端筛会漏 closed 任务 → 必须 OR `finishedBy.account` | **已实测 ✓ 2026-05-04** L5.1 cleanup 后查 detail 验证 |

## 11.2 list 端点子任务藏在 `.children[]`(高频陷阱)

**实测 2026-05-04** — `GET /executions/{eid}/tasks` 默认页(无论传 `limit=20/100/500/默认`)只返回**父任务 + 顶层任务**,子任务嵌在父对象的 `.children[]` 子数组里。漏 children 等于漏 60%+ 的真实任务。

**症状**:

- 用 `jq '.tasks[]'` 拉到的数量远少于 `.total`(执行 2028 实测 total=1567,page1 limit=500 实际 162 条 — 但全是父+顶层,真实 task 总数 ≥ 1567)
- detail 端点 `/tasks/{id}` 显示某 task 的 `execution=2028`,但 list 端点用 `.tasks[]?` 拉不到它

**根因**:list endpoint 的输出结构是嵌套的:

```jsonc
{
  "total": 1567,
  "tasks": [
    { "id": 43911, "name": "...", "parent": -1,        // 父任务
      "children": [                                       // ← 子任务在这里!
        { "id": 43912, "parent": 43911, "finishedBy": "qingwa", ... },
        { "id": 43913, "parent": 43911, ... }
      ]
    },
    { "id": 43928, "name": "...", "parent": 0 },          // 顶层任务
    ...
  ]
}
```

**修复**:jq 必须递归 children:

```bash
# 错(漏 60%+ 真实任务):
jq '[.tasks[]?]'

# 对(扁平化所有 task,顶层 + 子任务):
jq '[.tasks[]?] + [.tasks[]?.children[]?]'
```

**子任务字段差异**:`.children[]` 元素带完整 task 字段(含 finishedBy/finishedDate),但格式跟父任务不同:

| 字段 | 父任务(顶层 list 元素) | 子任务(`.children[]` 元素) |
|---|---|---|
| `assignedTo` | `{account, realname, ...}` object | `"qingwa"` 字符串 |
| `finishedBy` | object | string |
| `finishedDate` | `"2026-04-30T20:47:09Z"` ISO8601 | `"2026-04-30 20:47:09"` 空格分隔 |

**统一兼容写法**:

```jq
def u(f): (if (f|type) == "object" then (f.account // "") else (f // "") end);
def dt(s): if (s|tostring) == "" or (s|tostring) == null then "" else (s|tostring|.[0:10]) end;
```

P1 已用此写法。客户端筛 `.assignedTo.account == $me` 在 children 上必失败。

## 11.3 `/products/{pid}/bugs` 默认过滤 `status != closed`

**实测 2026-05-04** — 默认 `GET /products/{pid}/bugs` 只返回 status ∈ {active, resolved, confirmed} 的"活跃" bug,**已 closed 历史 bug 全部不返回**。

**实测对比**(product 95):

| 调用 | total | 实际拉到 | 含历史 closed bug? |
|---|---|---|---|
| `/products/95/bugs`(默认 limit=20) | 34 | 20 | ✗(全活跃) |
| `/products/95/bugs?limit=500` | **34** | 34 | ✗(全活跃) |
| `/products/95/bugs?status=all&limit=500` | **1115** | 500 | ✓(含历史 closed) |

**修复**:Bug 时间窗筛选(尤其是 resolvedDate / closedDate 在历史周)**必须加 `?status=all`**:

```bash
# 错(漏所有历史已关闭 bug,只能拉到本周新 resolved 还没 closed 的):
zt_paginate "/products/$pid/bugs"

# 对(覆盖历史):
zt_paginate "/products/$pid/bugs?status=all"
```

**不要传其他 status 单值**:`?status=resolved` `?status=closed` 都返 total=0(参数破坏查询)。**唯一接受的值是 `all`**。

P2、weekly-report data-collection.md R2 已修。

## 11.1 bytenew.com 实例特定行为(2026-05-04 实测)

| 现象 | 表现 | 应对 |
|------|------|------|
| `/feedbacks` 返回 HTML 错误页 | `module/feedback/control.php not found` | feedback 模块未部署,业务上跳过该端点 |
| `/tickets` 返回 HTML 错误页 | `module/ticket/control.php not found` | ticket 模块未部署,业务上跳过该端点 |
| `/programs` 响应内嵌**未转义** C0 控制字符 | jq 报 `Invalid string: control characters from U+0000 through U+001F must be escaped` | sanitize 必须 `tr -d '\000-\037'`(strip 全部 0-31),不能保留 `\t\n\r`。早期试图保留三者作合法 JSON 空白,实测被 Zentao 当 in-string 内容嵌入,保留即破解析 |
| closed scrum 项目 `/projects/{id}/stories` 返空 body | 0 字节响应,jq 报 `Invalid numeric literal at line 1, column 0` 或类似 | 调用方对该端点必须先判 `[ -z "$resp" ]`。同 project 的 `/bugs`/`/executions` 等不受影响,只 `/stories` 偶发 |
| zsh 默认 `local var; var=$(cmd)` 回显 `var=value` 到 stdout | `zt_paginate` 等函数输出夹杂 `resp='{...}'` `total=N`,jq -s 整流 parse fail | 函数顶部加 `setopt local_options typeset_silent 2>/dev/null`(zsh 函数级生效,bash 无害忽略)。snippet 已默认 |
| 子任务 `.parent` 字段 sentinel:`-1` 表示"我是父"非"我是子" | 直接 `select(.parent != 0)` 会捞到 parent 节点本身,后续 `zt_get /tasks/-1` → 404 | 找子任务用 `select(.parent > 0)`;父任务有自己的特征(子节点 sum)。`patterns.md` P3 已修 |
| zsh `for x in $multiline_var` 不按行迭代 | zsh 默认 SH_WORD_SPLIT off,把整个多行字符串当 1 个值,循环只迭代 1 次 → P1/P2 跨 sprint/product 聚合静默漏数据 | 用 `while IFS= read -r x; do ...; done <<< "$VAR"` 替代 `for x in $VAR`(bash/zsh 都对)。`patterns.md` P1/P2 已改 |
| 全量 254 exec 串行 paginate 偶发 jq -s 瞬时 parse 失败 | 单 exec / 静态文件 jq -s 都通过(verify 静态 258 页 + filter 149 条 ✓),只 live 长时间串行 1000+ HTTP 请求时偶发 | 健壮模式:先把 paginate 输出落盘 `> /tmp/p.out` 再 `jq -s < /tmp/p.out`。或调小并发:每个 exec 单独 jq filter 而非整流 slurp |
| P2 (`patterns.md` 跨产品聚合 Bug)未独立 live 验证 | L6.2 在 live 跑也命中同款 paginate 瞬时抖动;P2 与 P1 结构同型(只换 `.tasks[]?` → `.bugs[]?`、换 `finishedBy` → `resolvedBy`),Phase 5 仅基于 P1 静态验证 + 结构同型推断 P2 正确 | 真要 live 验 P2:`zt_get '/products/95/bugs?limit=500' \| jq --arg me qingwa '[.bugs[]? \| select(.assignedTo.account == $me or .resolvedBy.account == $me)] \| length'` 跑单产品确认 filter,再扩 |

代价说明:strip 全部 C0 后,多行 string 字段(如 program/project description)内部 `\n` 被吃掉,文本变成连排。只读 API 消费场景(取 ID/name/date/status)不受影响。如果将来需要保留多行内容,改用 `python -c "json.loads(sys.stdin.read().encode().decode('unicode_escape'))"` 或 `jq --slurpfile` 配合预处理。
