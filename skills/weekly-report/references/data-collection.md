# Data Collection — 禅道五块数据采集

> 前提:`SKILL.md §Setup` 已跑过 — `ZT_CACHE`、`ME`、`WK_START`、`WK_END`、`NEXT_S`、`NEXT_E`、`WK_NUM` 均已就绪,zentao-api 6 snippet 已 eval。
> 输出:5 个 jq array(R1-R5),每个独立可重跑、独立可校验。
> 全文遵守 [`zentao-api/references/patterns.md`](../../zentao-api/references/patterns.md) 三个 pattern:P1 跨执行任务、P2 跨产品 Bug/Story、P3 父子还原。
>
> ⚠️ **两个关键 list 端点陷阱(2026-05-04 实测,zentao-api/troubleshooting.md §11.2 / §11.3)**:
> 1. `/executions/{id}/tasks` 子任务藏在父对象的 `.children[]` 子数组 — jq 必须递归扁平化,否则漏 60%+ 真实任务。
> 2. `/products/{id}/bugs` 默认隐式过滤 `status != closed` — 要拉历史已关闭 bug 必须加 `?status=all`(R2 必须;R3 不需要)。

## 采集映射(R1 双语义)

| 块 | 业务含义 | 采用 pattern | 时间字段 | 状态过滤 | 用户字段 |
|---|---|---|---|---|---|
| R1-完成 | 本周已完成的任务 | P1 | `finishedDate` ∈ [WK_START, WK_END) | `status=done` 或 `closed` | `finishedBy == $ME` |
| R1-进行 | 本周仍在推进的任务 | P1 | `lastEditedDate` 或 `assignedDate` ∈ [WK_START, WK_END) | `status` ∈ {doing, wait, pause} | `assignedTo == $ME` |
| R2 | 本周解决的 Bug | P2 (KIND=bugs, **`?status=all`**) | `resolvedDate` ∈ [WK_START, WK_END) | — | `resolvedBy == $ME` |
| R3 | 待跟进 Bug(快照) | P2 (KIND=bugs) | — 不限时间 | `status=active` | `assignedTo == $ME` |
| R4 | 下周待开展任务 | P1 | `deadline` ∈ [NEXT_S, NEXT_E) | `status` ∈ {wait, doing} | `assignedTo == $ME` |
| R5 | 父子任务还原 | P3 | — | — | 对 R1/R4 中 `.parent > 0` 的项二次回查 |

## 字段兼容辅助(jq helper)

list 端点的 `.tasks[]` 父对象 `.assignedTo`/`finishedBy` 是 object,**`.children[]` 子对象是 string**;日期格式也不统一(ISO8601 vs 空格分隔)。jq 必须用以下两个 def 兼容:

```jq
def u(f): (if (f|type) == "object" then (f.account // "") else (f // "") end);
def dt(s): if (s|tostring) == "" or (s|tostring) == null then "" else (s|tostring|.[0:10]) end;
```

## R1 — 本周完成 + 进行中任务(双分支并集)

```bash
USER=$(zt_get /user)
SPRINT_VIEW=$(echo "$USER" | jq -r '.profile.view.sprints' | tr ',' '\n' | sort -u)
DOING=$(zt_get "/executions?status=doing&limit=500" | jq -r '.executions[].id' | sort -u)
MY_DOING=$(comm -12 <(echo "$SPRINT_VIEW") <(echo "$DOING"))

R1=$(while IFS= read -r sid; do
       [ -z "$sid" ] && continue
       zt_paginate "/executions/$sid/tasks" | LC_ALL=C tr -d '\000-\037'
     done <<< "$MY_DOING" \
  | jq -s --arg me "$ME" --arg s "$WK_START" --arg e "$WK_END" '
    def u(f): (if (f|type) == "object" then (f.account // "") else (f // "") end);
    def dt(s): if (s|tostring) == "" or (s|tostring) == null then "" else (s|tostring|.[0:10]) end;
    # 递归扁平化:顶层 + children
    ([.[].tasks[]?] + [.[].tasks[]?.children[]?])
    | map(
        (u(.finishedBy) == $me and dt(.finishedDate) >= dt($s) and dt(.finishedDate) < dt($e)) as $done |
        (u(.assignedTo) == $me and (.status == "doing" or .status == "wait" or .status == "pause")
          and dt(.lastEditedDate // .assignedDate) >= dt($s)
          and dt(.lastEditedDate // .assignedDate) < dt($e)) as $progress |
        if ($done or $progress) then
          {id, name, status, parent: (.parent // 0),
           execution: (.execution // .executionID // null),
           deadline, finishedDate, lastEditedDate,
           assignedTo: u(.assignedTo), finishedBy: u(.finishedBy),
           wk_role: (if $done then "完成" else "进行" end)}
        else empty end)
    | unique_by(.id)')

echo "$R1" > /tmp/wk-R1.json

# ⚠ 父任务去重:如果 R1 里某 task 是父(其 id 出现在其他 task.parent 中),
# 移除该父任务条目 — 子任务展示时已带"父名/子名"前缀,父行单独列重复。
jq '
  . as $all
  | ([$all[].parent // 0] | map(select(. > 0)) | unique) as $referenced_parents
  | map(select((.id | IN($referenced_parents[])) | not))
' /tmp/wk-R1.json > /tmp/wk-R1.json.tmp && mv /tmp/wk-R1.json.tmp /tmp/wk-R1.json

echo "[R1] 共 $(jq 'length' /tmp/wk-R1.json) 条 (完成: $(jq '[.[]|select(.wk_role=="完成")]|length' /tmp/wk-R1.json) 进行: $(jq '[.[]|select(.wk_role=="进行")]|length' /tmp/wk-R1.json))" >&2
```

> 父任务去重必须在数据层做(而不是渲染层),否则:
> - eval 检查 `n_tasks ≥ n_r1`(周报实际行数 ≥ R1 length) 会因父任务被渲染层去掉而 fail
> - 关键数据行的 task 总数也跟实际不一致

## R2 — 本周解决的 Bug(必须加 `?status=all`)

```bash
PRODUCT_VIEW=$(echo "$USER" | jq -r '.profile.view.products' | tr ',' '\n' | sort -u)

R2=$(while IFS= read -r pid; do
       [ -z "$pid" ] && continue
       zt_paginate "/products/$pid/bugs?status=all" | LC_ALL=C tr -d '\000-\037'
     done <<< "$PRODUCT_VIEW" \
  | jq -s --arg me "$ME" --arg s "$WK_START" --arg e "$WK_END" '
    def u(f): (if (f|type) == "object" then (f.account // "") else (f // "") end);
    def dt(s): if (s|tostring) == "" or (s|tostring) == null then "" else (s|tostring|.[0:10]) end;
    [.[] | .bugs[]?
     | select(u(.resolvedBy) == $me)
     | select(dt(.resolvedDate) >= dt($s) and dt(.resolvedDate) < dt($e))
     | {id, title, severity, pri, type, status, resolution,
        resolvedDate, openedDate,
        openedBy: u(.openedBy), resolvedBy: u(.resolvedBy),
        productID: .product}]
    | unique_by(.id)')

echo "$R2" > /tmp/wk-R2.json
echo "[R2] 共 $(jq 'length' /tmp/wk-R2.json) 条" >&2
```

> ⚠️ **不加 `?status=all` = bug 静默漏掉**:实测 W15-W17 历史 bug 在默认 list 调用下全部缺失(default 隐式过滤 `status != closed`)。

## R3 — 待跟进 Bug 快照(不加 `?status=all`)

```bash
R3=$(while IFS= read -r pid; do
       [ -z "$pid" ] && continue
       zt_paginate "/products/$pid/bugs" | LC_ALL=C tr -d '\000-\037'
     done <<< "$PRODUCT_VIEW" \
  | jq -s --arg me "$ME" '
    def u(f): (if (f|type) == "object" then (f.account // "") else (f // "") end);
    [.[] | .bugs[]?
     | select(u(.assignedTo) == $me)
     | select(.status == "active")
     | {id, title, severity, pri, type, status,
        openedDate, openedBy: u(.openedBy),
        assignedTo: u(.assignedTo), productID: .product}]
    | unique_by(.id)')

echo "$R3" > /tmp/wk-R3.json
echo "[R3] 共 $(jq 'length' /tmp/wk-R3.json) 条" >&2
```

> R3 是**快照**,目标就是 `status == "active"` 的 bug,默认 list 已经只返活跃 bug,**不需要加 `?status=all`**(加了反而拉到一堆已 closed,客户端再筛 active 浪费带宽)。

## R4 — 下周待开展任务(同样要递归 children)

```bash
R4=$(while IFS= read -r sid; do
       [ -z "$sid" ] && continue
       zt_paginate "/executions/$sid/tasks" | LC_ALL=C tr -d '\000-\037'
     done <<< "$MY_DOING" \
  | jq -s --arg me "$ME" --arg s "$NEXT_S" --arg e "$NEXT_E" '
    def u(f): (if (f|type) == "object" then (f.account // "") else (f // "") end);
    def dt(s): if (s|tostring) == "" or (s|tostring) == null then "" else (s|tostring|.[0:10]) end;
    ([.[].tasks[]?] + [.[].tasks[]?.children[]?])
    | map(select(u(.assignedTo) == $me)
          | select(.status == "wait" or .status == "doing")
          | select(dt(.deadline) >= dt($s) and dt(.deadline) < dt($e))
          | {id, name, status, deadline, pri, parent: (.parent // 0)})
    | unique_by(.id)')

echo "$R4" > /tmp/wk-R4.json
echo "[R4] 共 $(jq 'length' /tmp/wk-R4.json) 条" >&2
```

## R5 — 父子任务还原

R1/R4 里凡是 `.parent > 0` 的(它自己是子任务),回查父任务名。

```bash
parents_of () {
  local list_file="$1"
  jq -r '.[] | select(.parent > 0) | .parent' "$list_file" | sort -u | while IFS= read -r pid; do
    [ -z "$pid" ] && continue
    zt_get "/tasks/$pid" | jq -c '{id: .id, name: .name}'
  done | jq -s '.'
}

parents_of /tmp/wk-R1.json > /tmp/wk-R5-R1-parents.json
parents_of /tmp/wk-R4.json > /tmp/wk-R5-R4-parents.json
```

> 关键:用 `> 0` 而非 `!= 0`。`.parent == -1` 是"自己是父"的 sentinel,不要回查(详见 zentao-api/troubleshooting.md §11.1)。

## 装配:任务格式化

```bash
format_task_list () {
  local list_file="$1" parents_file="$2"
  jq -s --slurpfile parents "$parents_file" '
    (.[0]) as $tasks |
    ($parents[0] | map({(.id|tostring): .name}) | add) as $pmap |
    $tasks | map(
      (if has("wk_role") then (.wk_role + " ") else "" end) as $tag |
      if (.parent // 0) > 0 and ($pmap[(.parent|tostring)] // null) != null then
        "\($tag)【T\(.parent)】\($pmap[(.parent|tostring)])/\(.name)"
      else
        "\($tag)【T\(.id)】\(.name)"
      end
    )' "$list_file"
}

format_task_list /tmp/wk-R1.json /tmp/wk-R5-R1-parents.json > /tmp/wk-R1-formatted.json
format_task_list /tmp/wk-R4.json /tmp/wk-R5-R4-parents.json > /tmp/wk-R4-formatted.json
```

R1 输出形如:
```
完成 【T43849】618大促VOC评价优化/后端
完成 【T43911】评价情感优化针对宝洁环境隔离/后端
进行 【T43902】中差评跟踪处理
进行 【T43902】中差评跟踪处理/数据源配置
```

LLM 渲染时按 `wk_role` 分组到周报"已完成 / 推进中"两个子段。

## Bug 标题改写

模型职责:把 R2/R3 的原始 `title` 改写成可读中文(去命令行/路径/堆栈、保留业务语义),长度 ≤ 40 字。

```bash
# 输入示例:
#   "POS-001 [PROD] /api/v1/order 报 NPE,trace_id=abc123"
# 改写为:
#   "POS 下单接口空指针异常"
```

不在脚本里做(LLM 任务),但产出 JSON 必须带原始 title 给 LLM 改写,保留 id 配对。

## Bug 根因分类

按 `type` 字段映射:

| zentao type | 周报分类 |
|---|---|
| `codeerror` | 代码缺陷 |
| `config`, `install` | 配置问题 |
| `designdefect` | 需求缺失 |
| `others`, `standard`, `performance`, `security`, `automation` | 非缺陷类 |

```bash
jq '
  group_by(.type)
  | map({type: .[0].type, count: length, ids: [.[].id]})
' /tmp/wk-R2.json
```

LLM 按映射汇总到 4 行表(代码缺陷 / 配置问题 / 非缺陷类 / 需求缺失),每行算占比、写一句话根因总结。

## 整体一段式调用(本地 dry-run / cron 全量)

参考 `references/scripts/wr-collect.sh`(待落入 SKILL 子目录,目前 dry-run 用 `/tmp/wr-collect.sh`)。脚本流程 = setup → R1 → R2 → R3 → R4 → R5 → format。每段独立 stderr 日志计数。

整体产物清单:

| 文件 | 用途 |
|---|---|
| `/tmp/wk-R1.json` | 本周完成+进行中任务原始数据(带 wk_role 字段) |
| `/tmp/wk-R2.json` | 本周解决 Bug 原始数据 |
| `/tmp/wk-R3.json` | 待跟进 Bug 原始数据 |
| `/tmp/wk-R4.json` | 下周待开展任务原始数据 |
| `/tmp/wk-R5-R1-parents.json` | R1 父任务字典 |
| `/tmp/wk-R5-R4-parents.json` | R4 父任务字典 |
| `/tmp/wk-R1-formatted.json` | R1 展示字符串数组(带"完成/进行"前缀) |
| `/tmp/wk-R4-formatted.json` | R4 展示字符串数组 |

LLM 拿这 8 个文件 + AI Daily 摘要,按 [`template.md`](template.md) 渲染周报。

## 历史回归基线(2026-05-04 实测)

| 周 | 真实任务 | 实测(本采集) | 真实 Bug | 实测 Bug | 差异原因 |
|---|---|---|---|---|---|
| W15 | 7 | 8 | 5 | 4 | 任务多 1(真实漏填 T43317);Bug 少 1(B51837 是 huanghu 解决,真实手填错挂) |
| W16 | 5 | 5 ✓ | 5 | 5 ✓ | **完美吻合** |
| W17 | 5(只写数没列ID) | 8 | 3 | 3 ✓ | 任务实测更全(真实手填 5 个);Bug 完美 |
| W18 | 0(事故 lib 失效) | 4(完成2+进行2) | 0 | 6 | **数据采集恢复**,V3 测试任务被自然过滤(parent=0 但不在 list 端点返回内) |

结论:实测 ≥ 真实(实测发现真实周报手填遗漏 / 严守 resolvedBy 排除"代他人解决");本采集策略可信、可上线。
