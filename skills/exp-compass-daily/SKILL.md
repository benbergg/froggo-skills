---
name: exp-compass-daily
description: "体验罗盘-每日研发进度播报。从禅道采集单产品(默认 95 VOC)的需求/任务/Bug,AI 在对话内按 4 段模板撰写日报,跑 6 项数据自检,通过 create-report 广播到钉钉模板的默认接收群。模板名固化在 skill,运行时按名查 template_id 并缓存。触发词:体验罗盘、体验罗盘日报、研发进度播报、每日播报、daily compass、研发日报、产研日报、daily report、禅道日报、今日进度、今日 Bug、今日需求、当日处理。"
---

# 体验罗盘-每日研发进度播报

> 依赖 [`zentao-api`](../zentao-api/SKILL.md) skill 的 token 缓存 + [`dingtalk-log`](../dingtalk-log/SKILL.md) 的 OpenAPI 封装。
> 详细设计 [[20260507-体验罗盘日报-V2-设计文档]] + [[20260511-体验罗盘日报-V3-设计文档]]。
> **核心理念**:脚本只做"禅道→标准 JSON"的转换,AI 看完整 JSON 自己写报告,自检后用 `create-report`(默认 `to_chat=true`)广播到钉钉模板配置的**默认接收群**。模板名固化在 skill(默认 "体验罗盘日报"),运行时按名查 template_id 并缓存到本地,**不再把 template_id 入 env**。

## When to Use

触发词:**体验罗盘、体验罗盘日报、研发进度播报、每日播报、daily compass、研发日报、产研日报、daily report、禅道日报、今日进度、今日 Bug、今日需求、当日处理**。

`user-invocable: true`。手动与 cron 共享同一份 6 步代码路径,无人工确认分支;推到钉钉的是 `create-report` 默认广播条目,**广播范围由模板后台配置的 `default_received_convs` 决定**(脚本不写群 cid)。

## 环境变量

按命名空间分两层。脚本只信 `process.env`,不再 source `.env` 文件。

### 全局共享(所有 skill 共用)

| 变量 | 说明 |
|---|---|
| `ZENTAO_BASE_URL` | 例 `https://chandao.bytenew.com/zentao/api.php/v1` |
| `ZENTAO_ACCOUNT` | 禅道账号 |
| `ZENTAO_PASSWORD` | 禅道密码 |
| `DINGTALK_APPKEY` | 企业内部应用 AppKey |
| `DINGTALK_APPSECRET` | AppSecret |
| `DINGTALK_USERID` | 创建日志的 userid(显示为提交人) |

### skill 级(`DINGTALK_EXP_COMPASS_*` / `EXP_COMPASS_*` 命名空间)

| 变量 | 必填 | 说明 |
|---|---|---|
| `DINGTALK_EXP_COMPASS_TEMPLATE_NAME` | ☐ | 钉钉日志模板名,**默认 `体验罗盘日报`**(固化在 skill);仅在切换模板时设置 |
| `EXP_COMPASS_PRODUCTS` | ☐ | 禅道产品 id,默认 `95` |
| `EXP_COMPASS_API_BUDGET` | ☐ | 禅道 API 调用预算,默认 `300` |
| `EXP_COMPASS_HARD_TIMEOUT_MS` | ☐ | collect.js 硬超时,默认 `600000`(clamp 60s~30min) |

**注意**:不再设 `DINGTALK_EXP_COMPASS_TEMPLATE_ID` / `_TO_CHAT` / `_TO_USERIDS` / `_TO_CIDS`。template_id 在 Step 0 由 `resolve-template.js` 按模板名查询并缓存到 `~/.cache/exp-compass-daily/template.json`;广播范围一律走模板的 `default_received_convs`。

调试:`DRY_RUN=1` 仅对 `collect.js` 生效(跳过禅道 API);**钉钉调用走 `dingtalk-log create-report --dry-run` flag**,env `DRY_RUN` 对 dingtalk-log 无效。

### 加载机制

- **本地 macOS shell:** 在 `~/.zshrc` 或 `~/.zshenv` 里 `export`
- **本地 GUI 启动的 Claude Code:** `~/.zshenv` 或 `launchctl setenv`(zsh GUI 不读 zprofile)
- **tencent-vm openclaw cron:** `~/.openclaw/gateway.systemd.env` + `OPENCLAW_SERVICE_MANAGED_ENV_KEYS` 白名单

## 主流程(Step 0-6)

### Step 0 Setup + 模板解析

env 来源是 shell rc(本地)或 systemd EnvironmentFile(cron),脚本不再 source `.env`。

进入 Step 1 前快速校验必填 env:

```bash
for v in ZENTAO_BASE_URL ZENTAO_ACCOUNT ZENTAO_PASSWORD \
         DINGTALK_APPKEY DINGTALK_APPSECRET DINGTALK_USERID; do
  [ -z "${!v}" ] && echo "MISSING: $v"
done
```

任一 MISSING 则中止主流程,提示用户补 env 后重新触发。

**解析模板(必跑,产出 template_id 与字段名校验)**:

```bash
TPL_NAME="${DINGTALK_EXP_COMPASS_TEMPLATE_NAME:-体验罗盘日报}"
TPL_ID=$(node ${CLAUDE_PLUGIN_ROOT}/skills/exp-compass-daily/references/scripts/resolve-template.js \
  --template-name "$TPL_NAME" \
  --userid "$DINGTALK_USERID")
```

`resolve-template.js` 做三件事:
1. 调 `dingtalk-log get-template --template-name "$TPL_NAME"` 取模板详情
2. cross-check 模板 `fields[].field_name` 是否严格等于 `一、研发概览 / 二、 需求推进 / 三、今日产出 / 四、今日总结`(不一致时 stderr 列 WARN 但不阻塞,由 Step 6 的钉钉 errmsg 暴露真正问题)
3. 缓存 `{template_id, template_name, default_received_convs, fields}` 到 `~/.cache/exp-compass-daily/template.json` (mode 600,父目录 700)

stdout 是 `template_id`(单行),stderr 列字段校验结果与默认接收群信息。退出码:
- 0 = ok
- 1 = bad args
- 2 = lookup 失败(dingtalk-log 子进程退出非 0 或 errcode != 0)
- 3 = `.result.id` 缺失/为空(模板已被删除或权限不足)

非 0 则中止主流程,提示用户检查 `DINGTALK_EXP_COMPASS_TEMPLATE_NAME` 与钉钉模板配置。

### Step 1 数据采集

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/exp-compass-daily/references/scripts/collect.js \
  --product ${EXP_COMPASS_PRODUCTS:-95} \
  --date $(date +%Y-%m-%d) \
  --out /tmp/exp-compass-$(date +%Y-%m-%d).json
```

失败 → 退出,提示用户检查禅道凭据。成功后输出文件路径。

### Step 2 AI 撰写

1. `Read("/tmp/exp-compass-{DATE}.json")` 整体读
2. 按 § 模板原文 + § 撰写约束在对话内生成完整 Markdown
3. 在对话中 echo 整篇 MD(实际 Write 到知识库由 Step 4 完成)

### Step 3 AI 自检(必须跑)

按 § 自检 checklist 跑 C1-C6,最多 3 轮:
- 全过 → 进入 Step 4
- 有失败 → 在对话中列出失败项 + 改写 MD + 再跑
- 3 轮全失败 → 仍写 MD + 推广播日志,stderr 列瑕疵清单(C1-C6 失败项),run log 标 WARN

每轮失败原因都要 echo 给用户看(透明)。

### Step 4 Write 知识库 MD

```bash
# 由 AI 在对话内用 Write 工具写到固定路径
~/Knowledge-Library/05-Reports/daily/{DATE}.md
```

无论自检全过 还是 3 轮失败,都写入。3 轮失败时,stderr 列出瑕疵清单(C1-C6 失败项),但流程继续。

### Step 5 build-draft 切片 + 友好化

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/exp-compass-daily/references/scripts/build-draft.js \
  --md ~/Knowledge-Library/05-Reports/daily/$(date +%Y-%m-%d).md \
  --date $(date +%Y-%m-%d) \
  --out /tmp/exp-compass-$(date +%Y-%m-%d).contents.json
```

- 退出非 0 → 中止流程,echo stderr
- exit 4 = H1 锚点缺失或乱序,知识库 MD 已存,可手工修后重跑此步
- exit 0 + WARN = 概览表格残缺退化(钉钉条目仍创建,格式略丑)

### Step 6 创建钉钉日志(广播到模板默认群)

```bash
DATE=$(date +%Y-%m-%d)
CONTENTS_JSON=$(jq -c .contents /tmp/exp-compass-$DATE.contents.json)
TPL_ID=$(jq -r .template_id ~/.cache/exp-compass-daily/template.json)
# 模板配置的默认接收群 conversation_id 数组 — 必须显式注入 to_cids 才会触发群通知
TO_CIDS=$(jq -c '[.default_received_convs[].conversation_id]' ~/.cache/exp-compass-daily/template.json)
node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js create-report \
  --template-id "$TPL_ID" \
  --userid "$DINGTALK_USERID" \
  --contents "$CONTENTS_JSON" \
  --to-chat true \
  --to-cids "$TO_CIDS"
```

成功 echo `report_id`;失败 echo dingtalk-log 的 errcode + errmsg。

**关于广播语义**:钉钉 OpenAPI 实际行为是 `to_chat=true` **不会**自动 fanout 到模板 `default_received_convs`,**必须显式**把 `default_received_convs[].conversation_id` 注入 `--to-cids` 才会真触发群通知(2026-05-11 backtest 实证:`to_chat=true` + 空 `to_cids` → 日志创建成功但群无通知;补 `to_cids` 后群正确收到)。dingtalk-log `create-report` 默认 `to_chat=false`(safe no-broadcast),日志仅入 userid"我的日志"。`exp-compass-daily` 仍**不在脚本里硬写**群 cid,运行时从 resolve-template 缓存的 `default_received_convs` 读取,目标群由模板管理员在钉钉后台配置即可。

**调试 / DRY_RUN**:用 `--dry-run` flag(dingtalk-log 仅识别此 flag,**不识别 `DRY_RUN` env**)。dry-run 时 `dingtalk-log` 不真调 OpenAPI,只 echo `create_report_param` payload JSON,可在生产前 verify。例:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js create-report \
  --template-id "$TPL_ID" --userid "$DINGTALK_USERID" --contents "$CONTENTS_JSON" \
  --to-chat true --to-cids "$TO_CIDS" --dry-run
```

钉钉 token 失效由 dingtalk-log 自动重取,不必关心。

---

## 模板原文(撰写时严格遵循)

```markdown
体验罗盘-每日研发进度播报(YYYY-MM-DD)

# 一、研发概览
| 类型 | 进行中 | 今日新增 | 今日完成 | 待处理 |
|---|---|---|---|---|
| 需求 | {N1} | {N2} | {N3} | {N4} |
| 任务 | {N5} | {N6} | {N7} | {N8} |
| BUG | {N9} | {N10} | {N11} | {N12} |

# 二、需求推进

### S{id} {title} · {stage_cn} · 进度 {pct}%
| 任务ID | 任务名称 | 处理人 | 是否正常 |
|---|---|---|---|
| T{id} | {name} | {display_handler} | 正常 / ⚠️ 逾期 ({deadline}) |

(... 按 stage 排序:研发中 → 研发完毕 → 测试完毕,组内 id desc ...)

# 三、今日产出

## 完成的需求
- S{id} {title} [产品@{name} / 开发@{name} / 测试@{name}]

## 完成任务
- T{id} {name} [{finishedBy}]

## 修复 Bug
- B{id} {title} [{closedBy ?? resolvedBy}]

## 新增需求
- S{id} {title} [{openedBy}]

## 新增 Bug
- B{id} {title} [{openedBy}]

## 新增任务
- T{id} {name} [{openedBy}]

# 四、今日总结
{2-4 句具体陈述,必须含 ≥3 个 S/T/B id 引用,字数 80~200。
覆盖三维度:关键产出 / Bug 风险 / 逾期任务。
严禁泛泛话术(推进顺利、节奏稳定等)。}
```

---

## 撰写约束(6 条硬规则,严格遵守)

1. **概览表 4 列数字必须直接用 `summary.{story|task|bug}.{in_progress|today_new|today_done|todo}` 字段值**,严禁自己重数。

2. **需求推进段**:
   - 仅列 `stage ∈ {developing, developed, tested}` 的需求
   - 排序:研发中 → 研发完毕 → 测试完毕,组内按 id desc
   - 进度% 必须等于 `story.progress_pct`
   - 子任务表"处理人"列直接用 `task.display_handler`(脚本已根据 status 选好 finishedBy 或 assignedTo)
   - 子任务表"是否正常"列:`is_normal=true → 正常`,`false → ⚠️ 逾期 ({deadline:YYYY-MM-DD})`

3. **今日产出 6 段(必须按顺序、不可省略段、为空写 `- (无)`)**:

   | 段 | 数据来源 | 处理人/创建人 |
   |---|---|---|
   | 完成的需求 | `stories.filter(stage ∈ {closed,released,verified} && is_today_done)` | 拆 3 组:产品@`story.openedBy`、开发@`tasks.filter(type ∈ {devel,design}).map(finishedBy ?? assignedTo)` 去重、测试@`tasks.filter(type==test).map(finishedBy ?? assignedTo)` 去重;某角色为空则省略该角色组 |
   | 完成任务 | `(stories[].tasks ∪ loose_tasks).filter(is_today_finished && !is_aggregate_parent)` — `is_aggregate_parent=true` 表示该 parent 有 today-finished 的 child,跳过避免父+子重复 | `finishedBy` |
   | 修复 Bug | `bugs.filter(is_today_closed \|\| is_today_resolved)` | 用 `bug.display_handlers` 数组(脚本已组合 resolvedBy + closedBy 去重),渲染为 `[张三, 李四]`;空数组写 `[-]` |
   | 新增需求 | `stories.filter(is_today_opened)` | `openedBy` |
   | 新增 Bug | `bugs.filter(is_today_opened)` | `openedBy` |
   | 新增任务 | `(stories[].tasks ∪ loose_tasks).filter(is_today_created)` | `openedBy` |

4. **今日总结**:
   - 必须**写出具体名字、id、数字**(如"@虹猫 完成 S21241")
   - 至少覆盖三维度:**关键产出 / Bug 风险 / 逾期任务**
   - 严禁泛泛话术
   - 长度 80~200 字
   - **必须含 ≥3 个 id 引用**(S/T/B 任意组合,正则 `[STB]\d+`)

5. **任何提到的 id / 名字 / 数字必须在 JSON 中能找到**,严禁编造或推测。

6. **4 段 H1 锚点字符级精确**:
   - `# 一、研发概览`
   - `# 二、需求推进`
   - `# 三、今日产出`
   - `# 四、今日总结`

   不允许把"一、"改成"1.",不允许加 emoji 前缀,不允许前后多空格。`build-draft.js` 段切片依赖此精确匹配。

---

## 自检 checklist(6 项 cross-check,3 轮上限)

写完 MD 后必须自跑。任一失败 → 改写 → 再跑。

| # | 检查项 | 验证方法 |
|---|---|---|
| **C1** | 概览表数字 | grep MD 中的 `\| 需求 \| ... \|` 等 3 行,共 12 个数字与 `summary.{story\|task\|bug}.{in_progress\|today_new\|today_done\|todo}` 严格相等 |
| **C2** | 需求推进段覆盖 | MD 中 `### S{id}` 提到的 id 集合 == `stories.filter(stage ∈ {developing,developed,tested}).map(.id)` |
| **C3** | 今日产出 6 段完整性 | 6 段中每段 id 集合 ⊇ JSON 对应 filter 结果(完成任务段:filter 含 `!is_aggregate_parent`) |
| **C4** | 进度数字一致 | 每个 `进度 N%` 在 MD 中的 N 等于 `story.progress_pct` |
| **C5** | 逾期标记 | MD 中"⚠️ 逾期"的 task id 集合 == `tasks.filter(is_overdue).map(.id)` |
| **C6** | 总结具体性 | 今日总结段必须含 ≥3 个 `[STB]\d+`,且字数 ∈ [80, 200] |

### 自检反馈格式

每轮跑完后,在对话中输出:

```
自检 第N轮:
  C1 ✓
  C2 ✗ - 漏列 S21015 (stage=developed 但 MD 中无 ### S21015 块)
  C3 ✓
  C4 ✓
  C5 ✗ - T43314 is_overdue=true 但 MD 中未标 ⚠️
  C6 ✓
```

失败 → 改写指定段 → 进入下一轮。3 轮上限。

### 不在自检范围

- 措辞质量(C6 仅保底"具体性",文采由用户在钉钉 APP 我的日志查看后决定是否转发前最终判断)
- 时间一致性(${DATE} 已硬性绑定,无需再查)
- API 字段缺失(collect.js 已校验)
- H1 锚点正确性(写入约束 #6 已规定;若错则 build-draft.js Step 5 exit 4 暴露)

---

## 异常处理

| 异常 | 处理 |
|---|---|
| `collect.js` 退出非 0 | 中止主流程,echo stderr,提示检查 zentao 凭据 |
| Token 401 自动刷新失败 | `collect.js` 已退出,提示用户在终端跑 `zt_init && zt_acquire_token` |
| `summary` 字段缺失 | JSON 损坏,中止 Step 2,echo `cat /tmp/exp-compass-{DATE}.json \| jq .` |
| 自检 3 轮不过 | 仍写 MD + 推广播日志,stderr 列瑕疵,run log 标 WARN |
| `resolve-template.js` exit 2 | 钉钉 get-template 失败(模板名错/userid 无权限/网络),中止主流程,提示查 `DINGTALK_EXP_COMPASS_TEMPLATE_NAME` |
| `resolve-template.js` exit 3 | `.result.id` 为空(模板已被删除),中止主流程,提示在钉钉后台确认模板存在 |
| `resolve-template.js` 字段名 WARN | 不阻塞,流程继续;Step 6 若钉钉 errmsg 暴露字段不匹配,按 errmsg 修模板字段名后 `rm ~/.cache/exp-compass-daily/template.json` 重跑 |
| `build-draft.js` H1 锚点缺失 | exit 4,知识库 MD 仍存,手工修后重跑 Step 5+6 |
| `build-draft.js` 概览表格残缺 | 退化照搬原表格 + stderr WARN,流程继续 |
| `dingtalk-log create-report` 失败 | exit 3(dingtalk-log 内部码),知识库 MD 与 contents.json 仍存,手工 ssh 重跑 Step 6 |
| 模板 `default_received_convs` 为空 | Step 0 stderr WARN,Step 6 调用仍 errcode=0 但实际无人收到广播,需在钉钉后台为模板配置默认接收群 |

---

## 渐进式深读

| 何时读 | 文件 |
|---|---|
| 看不懂 collect.js 输出的 JSON 字段 | [`references/data-schema.md`](references/data-schema.md) |
| 修改模板解析 / 模板名固化策略 | `references/scripts/resolve-template.js` + `tests/run-resolve-template-tests.js` |
| 修改钉钉日志创建行为 | `references/scripts/build-draft.js`(切片+友好化) + dingtalk-log skill(API,V3 用 create-report 广播到模板默认群) |
| 修改数据采集逻辑 | `references/scripts/collect.js` |
| 理解整体架构与设计动机 | [[20260507-体验罗盘日报-V2-设计文档]] + [[20260511-体验罗盘日报-V3-设计文档]] |

---

## 硬约束

- **不直接调钉钉 OpenAPI**(由 dingtalk-log skill 接管)
- **不直接调禅道 `/tokens` API**(token 由 zentao-api skill 维护)
- **cron 与 manual 共享同一份代码路径**,无人工确认分支
- **数字必出自 collect.js JSON**:summary 是 ground truth,严禁 AI 自己重数
- **token 不入日志**:`collect.js` 与 `dingtalk-log` 已实装 sanitize
- **写入路径固定** `~/Knowledge-Library/05-Reports/daily/{DATE}.md`,用 Write 工具(不用 obsidian-cli)
- **H1 锚点字符级精确**:见撰写约束 #6;`build-draft.js` 切片依赖此精确匹配
- **模板名固化、template_id 不入 env**:`DINGTALK_EXP_COMPASS_TEMPLATE_NAME` 默认值 "体验罗盘日报"写在 skill 内,Step 0 由 `resolve-template.js` 按名查 template_id 并缓存到 `~/.cache/exp-compass-daily/template.json`。模板字段或群配置改动后,`rm` 该缓存文件即可触发下次运行重新查询。
- **钉钉广播范围由模板配置决定**:Step 6 **显式**传 `--to-chat true`(dingtalk-log 代码默认 `to_chat=false` safe no-broadcast),钉钉自动用模板的 `default_received_convs` 广播;脚本**不写群 cid**,调整接收群在钉钉后台改模板,不改代码。**不用 save-content**:实测 saveContent 端点 APP 不消费(返回 errcode=0 但内容无效)。**DRY_RUN 用 `--dry-run` flag,env `DRY_RUN` 无效**。
