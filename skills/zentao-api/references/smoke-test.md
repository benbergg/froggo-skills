# Live Smoke Test

> 单元测试用 mock curl 跑，覆盖纯函数逻辑。**真实 API** 链路必须用 live smoke test 验证。
>
> 不进 CI（需真实凭据）。

## 准备

```bash
export ZENTAO_BASE_URL="https://chandao.bytenew.com/zentao/api.php/v1"
export ZENTAO_ACCOUNT="qingwa"          # 你的账号
export ZENTAO_PASSWORD="..."             # 你的密码
# 可选
# export ZENTAO_CACHE_DIR="$HOME/.cache/zentao"

source skills/zentao-api/lib/zentao.sh
```

## L0 Token + User

```bash
acquire_token >/dev/null && echo "✓ token 取到"
zentao_call /user | jq -e '.profile.account' >/dev/null && echo "✓ /user OK"
zentao_call '/users?limit=1' | jq -e '.users[0].id' >/dev/null && echo "✓ /users OK"
```

## L1 入口列表

```bash
for ep in '/programs?limit=1' '/products?limit=1' '/projects?limit=1' '/executions?status=doing&limit=1'; do
  resp=$(zentao_call "$ep")
  echo "$resp" | jq -e '. | type' >/dev/null && echo "✓ $ep" || echo "✗ $ep: $resp"
done
```

## L2 二级（取入口里第一个 ID 用）

```bash
PROD_ID=$(zentao_call '/products?limit=1' | jq -r '.products[0].id')
PROJ_ID=$(zentao_call '/projects?limit=1' | jq -r '.projects[0].id')
EXEC_ID=$(zentao_call '/executions?status=doing&limit=1' | jq -r '.executions[0].id')

echo "PROD=$PROD_ID PROJ=$PROJ_ID EXEC=$EXEC_ID"

for ep in \
  "/products/$PROD_ID/plans?limit=1" \
  "/products/$PROD_ID/stories?limit=1" \
  "/products/$PROD_ID/bugs?limit=1" \
  "/products/$PROD_ID/projects?limit=1" \
  "/projects/$PROJ_ID/stories?limit=1" \
  "/projects/$PROJ_ID/bugs?limit=1" \
  "/projects/$PROJ_ID/executions?limit=1" \
  "/executions/$EXEC_ID/tasks?limit=1" \
  "/executions/$EXEC_ID/stories?limit=1" \
  "/executions/$EXEC_ID/bugs?limit=1" \
; do
  zentao_call "$ep" | jq -e '. | type' >/dev/null && echo "✓ $ep" || echo "✗ $ep"
done
```

## L3 详情

```bash
TASK_ID=$(zentao_call "/executions/$EXEC_ID/tasks?limit=1" | jq -r '.tasks[0].id // empty')
BUG_ID=$(zentao_call "/products/$PROD_ID/bugs?limit=1" | jq -r '.bugs[0].id // empty')
STORY_ID=$(zentao_call "/products/$PROD_ID/stories?limit=1" | jq -r '.stories[0].id // empty')

[ -n "$TASK_ID" ] && zentao_call "/tasks/$TASK_ID" | jq -e .id >/dev/null && echo "✓ /tasks/$TASK_ID"
[ -n "$BUG_ID" ] && zentao_call "/bugs/$BUG_ID" | jq -e .id >/dev/null && echo "✓ /bugs/$BUG_ID"
[ -n "$STORY_ID" ] && zentao_call "/stories/$STORY_ID" | jq -e .id >/dev/null && echo "✓ /stories/$STORY_ID"
```

## L4 已知残废端点（确认仍残废）

```bash
COUNT=$(zentao_call '/tasks?limit=500' | jq -r '.tasks | length')
if [ "$COUNT" = "1" ]; then
  echo "✓ /tasks 残废确认（仅返回 1 条，limit 失效）"
else
  echo "⚠ /tasks 行为变化（返回 $COUNT 条）—— 可能禅道修了，重新评估"
fi
```

## 真实周报 Recipe 跑一遍

执行 `references/recipes.md` 里的 R1~R4，输出非负整数即通过。

## 失败排查

| 现象 | 排查 |
|------|------|
| `FATAL: missing required env` | 三个必填环境变量都 export 了吗 |
| `FATAL: token acquire failed` | 账号密码对吗；POST body 字段是 `account`（lib 已正确） |
| `unauthorized` 后又失败 | `rm $ZENTAO_CACHE_DIR/token.json` 重试；检查密码 |
| 翻页死循环 | 仅在 `/executions/{id}/tasks` `/products/{id}/bugs` 等正常端点用 `paginate`；顶层 `/tasks` 禁用 |
| `Cannot iterate over null` | jq 过滤要用 `.tasks[]?` `.bugs[]?` 防御 |
