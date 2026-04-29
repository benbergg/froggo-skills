# Recipes（高频场景 jq 模板）

> 所有 recipe 假设已 `source skills/zentao-api/lib/zentao.sh`；`ME` 取自 `ZENTAO_ME` 或 `/user.profile.account`。
>
> 字段口径：
> - `finishedDate` `resolvedDate` `closedDate` `openedDate` 均为 `YYYY-MM-DDTHH:MM:SSZ` UTC，按字符串比较即可。
> - `deadline` 仅日期 `YYYY-MM-DD`；R4 中把 `WK_START` 切片到 `[0:10]` 后再比。
> - "本周"统一指**周一 00:00 ~ 下周一 00:00**。
> - `?` 在 `.tasks[]?` `.bugs[]?` 起防御作用（空数组 / 空 object 不抛错）。

## R1 — 本周我完成的任务

```bash
ME="${ZENTAO_ME:-$(get_user_cached | jq -r .profile.account)}"
compute_week_range
USER=$(get_user_cached)
SPRINT_VIEW=$(echo "$USER" | jq -r '.profile.view.sprints' | tr ',' '\n' | sort -u)
DOING=$(zentao_call "/executions?status=doing&limit=500" | jq -r '.executions[].id' | sort -u)
MY_DOING=$(comm -12 <(echo "$SPRINT_VIEW") <(echo "$DOING"))

for sid in $MY_DOING; do paginate "/executions/$sid/tasks"; done \
  | jq -s --arg me "$ME" --arg s "$WK_START" --arg e "$WK_END" '
    [.[].tasks[]?
     | select(.finishedBy.account == $me)
     | select(.finishedDate >= $s and .finishedDate < $e)
     | {id, name, status, executionID, executionName,
        deadline, finishedDate, parent, storyID, storyTitle}]'
```

为什么求交集而不是直接遍历 `view.sprints`：`view.sprints` 含**全部历史可见 sprint**（实测某账号 ~2700 个），直接遍历开销大；与 `status=doing` 交集后通常只剩个位数。

## R2 — 本周我解决的 Bug

```bash
ME="${ZENTAO_ME:-$(get_user_cached | jq -r .profile.account)}"
compute_week_range
USER=$(get_user_cached)
PRODUCT_VIEW=$(echo "$USER" | jq -r '.profile.view.products' | tr ',' '\n' | sort -u)

for pid in $PRODUCT_VIEW; do paginate "/products/$pid/bugs"; done \
  | jq -s --arg me "$ME" --arg s "$WK_START" --arg e "$WK_END" '
    [.[].bugs[]?
     | select(.resolvedBy.account == $me)
     | select(.resolvedDate >= $s and .resolvedDate < $e)
     | {id, title, severity, pri, status, resolution,
        product, productName, openedDate, resolvedDate}]'
```

## R3 — 待跟进 Bug（指派给我 & 仍激活）

```bash
ME="${ZENTAO_ME:-$(get_user_cached | jq -r .profile.account)}"
USER=$(get_user_cached)
PRODUCT_VIEW=$(echo "$USER" | jq -r '.profile.view.products' | tr ',' '\n' | sort -u)

for pid in $PRODUCT_VIEW; do paginate "/products/$pid/bugs"; done \
  | jq -s --arg me "$ME" '
    [.[].bugs[]?
     | select(.assignedTo.account == $me and .status == "active")
     | {id, title, severity, deadline, openedDate, product, productName}]'
```

## R4 — 下周待开展任务

```bash
ME="${ZENTAO_ME:-$(get_user_cached | jq -r .profile.account)}"
compute_week_range
USER=$(get_user_cached)
SPRINT_VIEW=$(echo "$USER" | jq -r '.profile.view.sprints' | tr ',' '\n' | sort -u)
DOING=$(zentao_call "/executions?status=doing&limit=500" | jq -r '.executions[].id' | sort -u)
MY_DOING=$(comm -12 <(echo "$SPRINT_VIEW") <(echo "$DOING"))

for sid in $MY_DOING; do paginate "/executions/$sid/tasks"; done \
  | jq -s --arg me "$ME" --arg s "${NEXT_S:0:10}" --arg e "${NEXT_E:0:10}" '
    [.[].tasks[]?
     | select(.assignedTo.account == $me)
     | select(.status == "wait" or .status == "doing")
     | select(.deadline >= $s and .deadline < $e)
     | {id, name, status, deadline, executionID, executionName, parent}]'
```

## R5 — 父子任务还原

```bash
TID=43846
parent_id=$(zentao_call "/tasks/$TID" | jq -r .parent)
[ "$parent_id" != "0" ] && [ "$parent_id" != "null" ] && \
  zentao_call "/tasks/$parent_id" | jq '{id, name}'
```
