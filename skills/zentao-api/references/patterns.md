# Patterns — 禅道 API 通用聚合模式

> 所有 pattern 假设已 `eval` `auth-and-curl.md` 的全部 snippet。
> `$ME` 取自 `$ZENTAO_ME` 或 `zt_get /user | jq -r .profile.account`。
> `$START / $END` 是 ISO8601 字符串(`2026-05-03T00:00:00Z`)或 `YYYY-MM-DD`,留空则跳过时间过滤。
>
> **去任务化硬约束**:本文件全文不出现 `WK_` `WEEK` `本周` `周报` `下周` 等字样。`zt_week_range` 仅作为可选辅助。

## P1 — 跨执行聚合任务

抽象:在某用户可见的 doing 执行集合中,按字段筛选任务。

数据流:`/user`.view.sprints ∩ `/executions?status=doing` → 遍历 `/executions/{eid}/tasks` → jq 筛。

```bash
ME="${ZENTAO_ME:-$(zt_get /user | jq -r .profile.account)}"
START="${1:-}"; END="${2:-}"   # 可留空跳过时间过滤

USER=$(zt_get /user)
SPRINT_VIEW=$(echo "$USER" | jq -r '.profile.view.sprints' | tr ',' '\n' | sort -u)
DOING=$(zt_get "/executions?status=doing&limit=500" | jq -r '.executions[].id' | sort -u)
MY_DOING=$(comm -12 <(echo "$SPRINT_VIEW") <(echo "$DOING"))

while IFS= read -r sid; do zt_paginate "/executions/$sid/tasks"; done <<< "$MY_DOING" \
  | jq -s --arg me "$ME" --arg s "$START" --arg e "$END" '
    [.[].tasks[]?
     | select($me == "" or .assignedTo.account == $me or .finishedBy.account == $me)
     | select($s == "" or .finishedDate >= $s)
     | select($e == "" or .finishedDate < $e)
     | {id, name, status, executionID, executionName, deadline, finishedDate, parent}]'

# 例 1: 时间窗内已完成任务 → 调 zt_week_range 后用 $WK_START $WK_END 作 START/END
# 例 2: 某用户全年所有任务 → ME=jane P1 2026-01-01 2027-01-01
# 例 3: 不限时间所有任务 → P1
```

(求交集而非直接遍历 `view.sprints` 的理由:`view.sprints` 含全部历史可见 sprint,实测某账号 ~2700 个;与 status=doing 交集后通常剩个位数。)

## P2 — 跨产品聚合 Bug/Story

抽象:在某用户可见的 product 集合中,按字段筛选 Bug 或 Story。

数据流:`/user`.view.products → 遍历 `/products/{pid}/{bugs|stories}` → jq 筛。

```bash
ME="${ZENTAO_ME:-$(zt_get /user | jq -r .profile.account)}"
START="${1:-}"; END="${2:-}"; KIND="${3:-bugs}"   # bugs 或 stories

USER=$(zt_get /user)
PRODUCT_VIEW=$(echo "$USER" | jq -r '.profile.view.products' | tr ',' '\n' | sort -u)

while IFS= read -r pid; do zt_paginate "/products/$pid/$KIND"; done <<< "$PRODUCT_VIEW" \
  | jq -s --arg me "$ME" --arg s "$START" --arg e "$END" --arg k "$KIND" '
    [.[] | .[$k][]?
     | select($me == "" or .assignedTo.account == $me or .resolvedBy.account == $me)
     | select($s == "" or (.resolvedDate // .openedDate) >= $s)
     | select($e == "" or (.resolvedDate // .openedDate) < $e)]'

# 例 1: 时间窗内已解决 Bug → P2 $START $END bugs
# 例 2: 某产品全年所有 Story → P2 2026-01-01 2027-01-01 stories
```

> jq 语法注意:`.[$k]` 是动态 key 取值,必须先 `.[]` 解开 jq -s 的外层数组,再 `.[$k][]?` 取动态 key 的内嵌数组(`?` 防御空值)。**不要写成 `.[][$k][]?`**(jq 解析失败)。

## P3 — 父子关系还原

抽象:拿到子记录后回查父记录。适用于任意带 `.parent` 字段的实体(task / story 等)。

`.parent` sentinel(实测):`0` 无父子关系;`-1` 自己是父(有子任务);`正整数 N` 自己是子,父 ID = N。所以"找父"必须用 `> 0` 筛,`!= 0` 会把 -1(父自身)误判为子。

```bash
TID="$1"   # 任务 / 需求 ID
parent_id=$(zt_get "/tasks/$TID" | jq -r .parent)
if [ "$parent_id" -gt 0 ] 2>/dev/null; then
  zt_get "/tasks/$parent_id" | jq '{id, name}'
fi
```

附:在一批 task list 里挑出"子任务"(用于 P1/P2 拼接):

```bash
jq '.tasks[]? | select(.parent > 0)'
```

## P4 — 客户端 jq 筛选模板

抽象:服务端 `?assignedTo=` 等参数被忽略,统一在 jq 端筛。本 pattern 只有 jq 模板,无 HTTP 调用 — 与 P1/P2 拼接使用。

```bash
ME="$1"; START="$2"; END="$3"; STATUS="$4"; ASSIGNED="$5"

# 输入:任意端点返回的 list 数组(从 stdin)
jq --arg me "$ME" --arg s "$START" --arg e "$END" --arg st "$STATUS" --arg as "$ASSIGNED" '
  [.[] |
    select($as == "" or .assignedTo.account == $as) |
    select($me == "" or .openedBy.account == $me or .resolvedBy.account == $me) |
    select($st == "" or .status == $st) |
    select($s  == "" or (.resolvedDate // .openedDate // "") >= $s) |
    select($e  == "" or (.resolvedDate // .openedDate // "") <  $e)]'
```
