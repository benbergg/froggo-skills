# Verify — 禅道 API 连通性自检

> 任意环境(新部署、换实例、密码变更)的快速自检。完全不依赖 lib,直接复用 `auth-and-curl.md` 的 snippet。
>
> 不进 CI(需真实凭据)。

## 准备

```bash
export ZENTAO_BASE_URL="https://chandao.bytenew.com/zentao/api.php/v1"
export ZENTAO_ACCOUNT="..."
export ZENTAO_PASSWORD="..."

# 复制 auth-and-curl.md 的 6 段 snippet 到当前 shell 后:
zt_init && echo "✓ env"
```

## L0 — Token + /user

```bash
zt_acquire_token >/dev/null && echo "✓ token"
zt_get /user | jq -e '.profile.account' >/dev/null && echo "✓ /user"
```

## L1 — 11 个入口端点

```bash
for ep in '/users?limit=1' '/departments?limit=1' '/programs?limit=1' \
          '/products?limit=1' '/projects?limit=1' '/executions?status=doing&limit=1' \
          '/productplans?limit=1' '/feedbacks?limit=1' '/tickets?limit=1' \
          '/testtasks?limit=1' ; do
  resp=$(zt_get "$ep")
  echo "$resp" | jq -e '. | type' >/dev/null && echo "✓ $ep" || echo "✗ $ep: $resp"
done
```

## L2 — 二级端点(基于 L1 拿到的 ID)

```bash
PROD_ID=$(zt_get '/products?limit=1' | jq -r '.products[0].id')
PROJ_ID=$(zt_get '/projects?limit=1' | jq -r '.projects[0].id')
EXEC_ID=$(zt_get '/executions?status=doing&limit=1' | jq -r '.executions[0].id')

# 注:不用 brace 展开 + tr ','(展开后是空格分隔,tr 无逗号可切)
{
  for sub in plans stories bugs projects releases; do echo "/products/$PROD_ID/$sub"; done
  for sub in stories bugs executions builds releases testtasks; do echo "/projects/$PROJ_ID/$sub"; done
  for sub in tasks stories bugs builds; do echo "/executions/$EXEC_ID/$sub"; done
} | while read -r e; do
  resp=$(zt_get "${e}?limit=1")
  if [ -z "$resp" ]; then
    echo "⚠ $e (empty body)"
  elif printf '%s' "$resp" | jq -e '. | type' >/dev/null 2>&1; then
    echo "✓ $e"
  else
    echo "✗ $e"
  fi
done
```

## L3 — 详情端点

```bash
TASK_ID=$(zt_get "/executions/$EXEC_ID/tasks?limit=1" | jq -r '.tasks[0].id // empty')
BUG_ID=$(zt_get "/products/$PROD_ID/bugs?limit=1"     | jq -r '.bugs[0].id // empty')
STORY_ID=$(zt_get "/products/$PROD_ID/stories?limit=1" | jq -r '.stories[0].id // empty')

[ -n "$TASK_ID" ]  && zt_get "/tasks/$TASK_ID"   | jq -e .id >/dev/null && echo "✓ task $TASK_ID"
[ -n "$BUG_ID" ]   && zt_get "/bugs/$BUG_ID"     | jq -e .id >/dev/null && echo "✓ bug $BUG_ID"
[ -n "$STORY_ID" ] && zt_get "/stories/$STORY_ID" | jq -e .id >/dev/null && echo "✓ story $STORY_ID"
```

## L4 — 残废端点回归

```bash
# 顶层 /tasks 应仍然 limit 失效(始终 1 条)
COUNT=$(zt_get '/tasks?limit=500' | jq -r '.tasks | length')
[ "$COUNT" = "1" ] && echo "✓ /tasks 仍残废" || echo "⚠ /tasks 行为变化(返回 $COUNT 条)"

# /products/{id}/bugs?status= 应仍然破坏查询
TOT=$(zt_get "/products/$PROD_ID/bugs?status=resolved&limit=1" | jq -r '.total // 0')
[ "$TOT" = "0" ] && echo "✓ ?status= 仍破坏 bugs 查询" || echo "⚠ ?status= 行为变化(total=$TOT)"
```

## L5 — 生产实例偏差回归(填回 known-issues.md §11 差异表)

> **本节是 V3 关键交付**。逐项跑,把 known-issues.md §11 表中所有 `lib 推断` 行的实际方法 + 路径回填,改证据来源为 `已实测 ✓ + 日期`。
>
> ⚠️ **生产数据保护硬约束**:严禁直接对生产已有的任务/Bug 操作。每节先创建专用一次性测试任务/Bug(标题前缀 `V3 verify L5 - delete after`),所有方法实测都在它上面跑,完成后 finish + close 它。

### L5.1 任务方法实测(POST vs PUT,在专用测试任务上)

```bash
EXEC_ID=$(zt_get '/executions?status=doing&limit=1' | jq -r '.executions[0].id')
[ -z "$EXEC_ID" ] || [ "$EXEC_ID" = "null" ] && echo "FATAL: no doing execution" && return 1

# 1. 创建专用测试任务 #1(用于 POST 实测)
TID=$(zt_write POST "/executions/$EXEC_ID/tasks" "$(jq -cn '{
  name:"V3 verify L5 POST - delete after", type:"devel",
  estStarted:"2026-05-03", deadline:"2026-05-04", estimate:0.1
}')" | jq -r '.id')
[ -z "$TID" ] || [ "$TID" = "null" ] && echo "FATAL: failed to create test task" && return 1
echo "✓ 创建测试任务 TID=$TID"

# 2. POST 试 start
echo "--- POST /tasks/$TID/start ---"
zt_write POST "/tasks/$TID/start" '{"left":0.1}' | head -c 200; echo

# 3. 创建测试任务 #2(用于 PUT 实测)
TID2=$(zt_write POST "/executions/$EXEC_ID/tasks" "$(jq -cn '{
  name:"V3 verify L5 PUT - delete after", type:"devel",
  estStarted:"2026-05-03", deadline:"2026-05-04", estimate:0.1
}')" | jq -r '.id')
echo "✓ 创建测试任务 TID2=$TID2"
echo "--- PUT /tasks/$TID2/start ---"
zt_write PUT "/tasks/$TID2/start" '{"left":0.1}' | head -c 200; echo

# 4. 清理:finish + close 两个测试任务
for t in "$TID" "$TID2"; do
  zt_write POST "/tasks/$t/finish" '{"currentConsumed":0.1,"finishedDate":"2026-05-03T00:00:00Z"}' >/dev/null
  zt_write POST "/tasks/$t/close"  '{"comment":"verify L5 cleanup"}' >/dev/null
done
echo "✓ 测试任务已 close(无 DELETE,close 是终态)"
```

记录到 known-issues §11 差异表:`POST 成功 / PUT 成功(或 405 Method Not Allowed)`。

### L5.2 Bug 方法实测(POST vs PUT,在专用测试 Bug 上)

```bash
PROD_ID=$(zt_get '/products?limit=1' | jq -r '.products[0].id')
[ -z "$PROD_ID" ] || [ "$PROD_ID" = "null" ] && echo "FATAL: no product" && return 1

# 1. 创建测试 Bug #1(用于 POST 实测)
BID=$(zt_write POST "/products/$PROD_ID/bugs" "$(jq -cn '{
  title:"V3 verify L5 POST - delete after",
  severity:4, pri:4, type:"others"
}')" | jq -r '.id')
[ -z "$BID" ] || [ "$BID" = "null" ] && echo "FATAL: failed to create test bug" && return 1
echo "✓ 创建测试 Bug BID=$BID"
echo "--- POST /bugs/$BID/confirm ---"
zt_write POST "/bugs/$BID/confirm" '{"comment":"verify L5 POST"}' | head -c 200; echo

# 2. 创建测试 Bug #2(用于 PUT 实测)
BID2=$(zt_write POST "/products/$PROD_ID/bugs" "$(jq -cn '{
  title:"V3 verify L5 PUT - delete after",
  severity:4, pri:4, type:"others"
}')" | jq -r '.id')
echo "--- PUT /bugs/$BID2/confirm ---"
zt_write PUT "/bugs/$BID2/confirm" '{"comment":"verify L5 PUT"}' | head -c 200; echo

# 3. 清理:resolve + close 两个测试 Bug
for b in "$BID" "$BID2"; do
  zt_write POST "/bugs/$b/resolve" '{"resolution":"bydesign","comment":"verify L5 cleanup"}' >/dev/null
  zt_write POST "/bugs/$b/close"   '{"comment":"verify L5 cleanup"}' >/dev/null
done
echo "✓ 测试 Bug 已 close"
```

### L5.3 用例端点路径

```bash
PROD_ID=$(zt_get '/products?limit=1' | jq -r '.products[0].id')

# /testcases
echo "--- /products/$PROD_ID/testcases ---"
zt_get "/products/$PROD_ID/testcases?limit=1" | head -c 200; echo

# /cases
echo "--- /products/$PROD_ID/cases ---"
zt_get "/products/$PROD_ID/cases?limit=1" | head -c 200; echo
```

预期:其中之一返回正常 JSON,另一个 404 / error。

### L5.4 测试单端点路径

```bash
# /testtasks
echo "--- /testtasks ---"
zt_get '/testtasks?limit=1' | head -c 200; echo

# /testsuites
echo "--- /testsuites ---"
zt_get '/testsuites?limit=1' | head -c 200; echo
```

## L6 — patterns.md 数据流烟测

> 验 P1/P2/P3 能跑通(返回合法 JSON 数组),不判内容。需 L0–L2 全通过。
> P4 是纯 jq 模板,无 HTTP 调用,不入烟测。

### L6.1 P1 跨执行聚合任务

```bash
ME=$(zt_get /user | jq -r .profile.account)
SPRINT_VIEW=$(zt_get /user | jq -r '.profile.view.sprints' | tr ',' '\n' | sort -u)
DOING=$(zt_get '/executions?status=doing&limit=500' | jq -r '.executions[].id' | sort -u)
MY_DOING=$(comm -12 <(echo "$SPRINT_VIEW") <(echo "$DOING"))

if [ -z "$MY_DOING" ]; then
  echo "⚠ P1 跳过: $ME 与 doing 执行无交集"
else
  RESULT=$(while IFS= read -r sid; do zt_paginate "/executions/$sid/tasks"; done <<< "$MY_DOING" \
    | jq -s --arg me "$ME" '[.[].tasks[]? | select(.assignedTo.account == $me or .finishedBy.account == $me)]')
  echo "$RESULT" | jq -e 'type == "array"' >/dev/null \
    && echo "✓ P1 OK ($(echo "$RESULT" | jq length) 条)" \
    || echo "✗ P1 失败"
fi
```

### L6.2 P2 跨产品聚合 Bug

```bash
ME=$(zt_get /user | jq -r .profile.account)
PRODUCT_VIEW=$(zt_get /user | jq -r '.profile.view.products' | tr ',' '\n' | sort -u)

if [ -z "$PRODUCT_VIEW" ]; then
  echo "⚠ P2 跳过: $ME 无可见 product"
else
  RESULT=$(while IFS= read -r pid; do zt_paginate "/products/$pid/bugs"; done <<< "$PRODUCT_VIEW" \
    | jq -s --arg me "$ME" '[.[] | .bugs[]? | select(.assignedTo.account == $me or .resolvedBy.account == $me)]')
  echo "$RESULT" | jq -e 'type == "array"' >/dev/null \
    && echo "✓ P2 OK ($(echo "$RESULT" | jq length) 条)" \
    || echo "✗ P2 失败"
fi
```

### L6.3 P3 父子关系还原

注:`.parent > 0` 才是真子任务。`-1` 是 sentinel"我是父"(详见 known-issues §11.1)。
单页足够烟测,避开 paginate 流式 jq 风险。

```bash
EXEC_ID=$(zt_get '/executions?status=doing&limit=1' | jq -r '.executions[0].id')
CHILD_TID=$(zt_get "/executions/$EXEC_ID/tasks?limit=500" \
  | jq -r '.tasks[]? | select(.parent > 0) | .id' | head -1)

if [ -z "$CHILD_TID" ]; then
  echo "⚠ P3 跳过: exec $EXEC_ID 首页无子任务"
else
  PARENT_ID=$(zt_get "/tasks/$CHILD_TID" | jq -r .parent)
  zt_get "/tasks/$PARENT_ID" | jq -e .id >/dev/null \
    && echo "✓ P3 OK (子 $CHILD_TID → 父 $PARENT_ID)" \
    || echo "✗ P3 失败"
fi
```

判定:三条都打 `✓` 或 `⚠ 跳过`(无数据可测,非失败)即通过;出现 `✗` 即失败,需要查 jq 表达式或上游 L1/L2 是否实际通了。

## 失败排查

| 现象 | 排查 |
|------|------|
| `FATAL: missing required env` | 三个必填 env 都 export 了吗 |
| `FATAL: token acquire failed` | 账号密码对吗;POST body 字段是 `account`(不是 `username`) |
| `unauthorized` 后又失败 | `rm $ZT_CACHE/token.json` 重试;检查密码 |
| `Cannot iterate over null` | jq 过滤要用 `.tasks[]?` `.bugs[]?` 防御 |
| 翻页死循环 | 仅在 `/executions/{id}/tasks` `/products/{id}/bugs` 等正常端点用 `zt_paginate`;顶层 `/tasks` 禁用 |
