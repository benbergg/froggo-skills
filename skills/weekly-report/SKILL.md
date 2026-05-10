---
name: weekly-report
description: "产研周报自动生成。Node 脚本从禅道采集本周完成任务/解决 Bug/待跟进 Bug/下周计划为单一 JSON,AI 在对话内按模板撰写周报,跑 7 项断言自检,人工预览确认后写入 Knowledge-Library/05-Reports/weekly/、git push、发送飞书摘要。触发词:周报、研发周报、产研周报、weekly report、青蛙周报、本周完成、本周 Bug、下周计划。"
---

# 产研周报自动生成

> 依赖 [`zentao-api`](../zentao-api/SKILL.md) skill 的 token 缓存与 `zt-functions.sh` 桥接。
> **核心理念**(与 [`exp-compass-daily`](../exp-compass-daily/SKILL.md) V2 一致):脚本只做"禅道→标准 JSON"转换,AI 看完整 JSON 自己写报告,自检后人工确认再保存推送。

## When to Use

触发关键词:**周报、研发周报、产研周报、weekly report、青蛙周报、本周完成、本周解决的 Bug、本周待跟进 Bug、下周计划**。

`user-invocable: true`,可手动 dry-run;也可由 openclaw cron `0 18 * * 6` 自动触发。

## 必填环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ZENTAO_BASE_URL` | ✓ | 例 `https://chandao.bytenew.com/zentao/api.php/v1` |
| `ZENTAO_ACCOUNT` | ✓ | 登录账号(本人) |
| `ZENTAO_PASSWORD` | ✓ | 密码 |
| `ZENTAO_ME` | – | 缺省取 `/user.profile.account`;周报筛选以本人为准 |
| `KNOWLEDGE_LIB` | ✓ | 周报输出根目录(本地与服务器路径不同,各环境的 `.env` 自行设置,不再有 default fallback) |
| `AI_DAILY_DIR` | – | 缺省 `$KNOWLEDGE_LIB/08-Research/AI-Daily/Daily`,AI Daily 源目录 |

凭据加载:`set -a; source ~/.openclaw/.env 2>/dev/null || source ~/.zentao.env; set +a`

## 主流程(Step 0-5)

### Step 0 Setup

```bash
set -a; source ~/.openclaw/.env 2>/dev/null || source ~/.zentao.env 2>/dev/null || true; set +a
```

校验 3 个禅道 env(缺则在 Step 1 前停下并 echo 缺哪些)。计算本周 ISO 周由 collect-weekly.js 内置完成,无需 shell 操作。

### Step 1 数据采集

```bash
# 采集本周(默认)
node ${CLAUDE_PLUGIN_ROOT}/skills/weekly-report/references/scripts/collect-weekly.js \
  --out /tmp/weekly-current.json

# 或指定历史周
# node ... --week 2026-W18 --out /tmp/weekly-2026-W18.json
```

退出码语义(详见 § 异常处理):
- `0` 成功,stdout 末行 `OK week=... done=... bug_resolved=...`
- `5` API budget 触顶 → 数据残缺,**不要继续后续步骤**;按 stderr 提示设 `WEEKLY_API_BUDGET=4000` 重跑
- `1` / `4` 凭据 / 超时类一般错误,看 stderr 决定如何处理

成功后从输出文件名解析 `WK_NUM`(或读 JSON `.week` 字段),后续 Step 2-5 使用。

> **调试场景**:刻意用小预算复现 budget 行为时,可加 `--allow-partial` 或 `WEEKLY_ALLOW_PARTIAL=1` 让脚本即便残缺也 exit 0。**生产/cron 不要用**。

### Step 2 AI Daily 摘要(独立步骤)

按 [`references/ai-daily-digest.md`](references/ai-daily-digest.md) 读最近 7 天 AI Daily 提炼 2~3 条,产出 `/tmp/wk-outlook.md`。本周无数据则跳过该板块(自检 C7 会标 `skipped`,允许通过)。

### Step 3 AI 撰写

1. `Read("/tmp/weekly-{WK_NUM}.json")` 整体读
2. `Read("/tmp/wk-outlook.md")`(若 Step 2 有产出)
3. 按 § 模板原文 + § 撰写约束在对话内生成完整 Markdown
4. `Write` 到 `/tmp/weekly-{WK_NUM}.md`(本地预览,**不**直接写知识库)
5. 在对话中 echo 整篇 MD 让用户预览

### Step 4 AI 自检(必须跑)

按 § 自检 checklist 跑 C1-C7,最多 3 轮:
- 全过 → 进入 Step 5
- 有失败 → 在对话中列出失败项 + 改写 MD + 再跑
- 3 轮全失败 → AskUserQuestion 让用户裁决:`带瑕疵保存 / 重新生成 / 取消`

每轮失败原因都要 echo 给用户看(透明)。

### Step 5 人工确认 + 保存推送

```
question: "数据自检全过(或 3 轮失败)。保存到知识库并推送吗?"
options:
  - 保存 + git push + 飞书摘要
  - 仅保存,不 push 不发飞书
  - 让我改写指定段后重新走 Step 4
  - 取消(不保存,/tmp 文件不动)
```

选"保存 + git push + 飞书摘要"时:
```bash
[ -n "$KNOWLEDGE_LIB" ] || { echo "FATAL: KNOWLEDGE_LIB not set" >&2; exit 1; }
DEST="$KNOWLEDGE_LIB/05-Reports/weekly/${WK_NUM}-工作周报.md"
cp /tmp/weekly-${WK_NUM}.md "$DEST"
cd "$KNOWLEDGE_LIB" && git add 05-Reports/weekly/${WK_NUM}-工作周报.md \
  && git commit -m "docs(weekly): ${WK_NUM} 工作周报" \
  && git pull --rebase \
  && git push
```

git push 失败 → `git pull --rebase` 后重试一次,仍失败上报用户,**不要** `--force`。

飞书摘要按 § 飞书摘要 格式输出。

---

## 模板原文(撰写时严格遵循)

### 命名约定

```
$KNOWLEDGE_LIB/05-Reports/weekly/${WK_NUM}-工作周报.md
```

`WK_NUM` 形如 `2026-W19`(由 collect 输出的 `week` 字段)。

### Frontmatter

```yaml
---
created: YYYY-MM-DD          # 周报生成日(本周周日或周六)
updated: YYYY-MM-DD          # 同 created
status: 已完成
project: bytenew-voc
tags:
  - type/周报
  - weekly
  - zentao
  - voc
week: YYYY-WXX               # = WK_NUM
aliases:
  - YYYY-WXX周报
---
```

### 正文骨架

```markdown
# ${WK_NUM} 工作周报

> 数据主要依据禅道整理,统计周期为 ${WK_START_DATE} ~ ${WK_END_DATE}。

## 本周OKR完成情况

### 1. 本周完成的任务

- {display_path} 【{status_cn}】
- ...

完成情况说明:
{2~3 句业务归纳,见 § 叙述风格 §1}

### 2. 本周处理的 Bug

本周已解决与待继续跟进的 Bug 如下:

**已解决:**
- B{id} {改写后的可读中文标题}
- ...

**待跟进:**
- B{id} {改写后的可读中文标题}
- ...

**本周关键数据:完成任务 ${task_done} 个,推进任务 ${task_progress} 个,已解决 Bug ${bug_resolved} 个,待跟进 ${bug_active} 个。**

**Bug 分析(按根因分布):**

| 分类 | 数量 | 占比 | 说明 |
|------|------|------|------|
| 代码缺陷 | X | X% | (一句话总结主要问题类型) |
| 配置问题 | X | X% | (一句话总结主要问题类型) |
| 需求缺失 | X | X% | (一句话总结主要问题类型) |
| 非缺陷类 | X | X% | (一句话总结主要问题类型) |

**两大痛点(可选,Bug ≥ 5 个时填):**
1. **(问题领域一)**:(一句话描述)
2. **(问题领域二)**:(一句话描述)

## AI在当周工作中的应用

| 应用场景 | AI工具 | 效果 |
|----------|--------|------|
| 禅道数据整理 | OpenClaw + zentao-api | 通过 API 自动提取任务和 Bug 数据 |
| 周报生成 | OpenClaw | 自动汇总、结构化输出,含 7 项断言自检闸门 |
| 知识沉淀 | OpenClaw + Knowledge-Library | 自动保存、提交并推送 |
| (其他本周 AI 应用,至少补 1 行) |  |  |

## 下周OKR计划

> ${NEXT_LABEL}(${NEXT_S_DATE} ~ ${NEXT_E_DATE})。下周主要任务以禅道未完成/未开始任务为主,可补充少量本周未入禅道的紧急项。

| 优先级 | 任务 | 目标 | 禅道 |
|--------|------|------|------|
| P0 | (任务名,T 编号放后缀如 "...(T43919)") | (动作 + 成效,非状态字典) | 进行中 / 未开始 / 暂无 |
| P1 | ... | ... | ... |
| P2 | ... | ... | ... |

## 向外看输入(视野情报)

(2~3 条;每条:外部动态 + 与我们的关联/启示 + AI Daily 来源日期)

### 1. {标题}
**外部动态:** {1~3 句具体描述,带数字/事实}
**与我们的关联/启示:** {1~2 句,要有判断}
**来源:** AI Daily MM-DD / MM-DD

### 2. {标题}
...

### 3. {标题,可选}
...

---
*报告生成时间:${GEN_TIME} (Asia/Shanghai)*
*下次采集:${NEXT_GEN_DATE}(${WK_NEXT_NUM} 周六)*
```

### 占位变量速查

| 变量 | 来源 |
|---|---|
| `${WK_NUM}` | JSON `week` 字段 |
| `${WK_START_DATE}` / `${WK_END_DATE}` | JSON `wk_start` / `wk_end` 取前 10 字符;`WK_END_DATE` 应取 `wk_end - 1天`(展示为本周日) |
| `${task_done}` / `${task_progress}` | JSON `summary.task_done` / `summary.task_progress` |
| `${bug_resolved}` / `${bug_active}` | JSON `summary.bug_resolved` / `summary.bug_active` |
| `${NEXT_LABEL}` | 例 `W20`(=WK_NUM 周数 + 1) |
| `${NEXT_S_DATE}` / `${NEXT_E_DATE}` | JSON `next_s` / `next_e` 取前 10 字符;`NEXT_E_DATE` 取 `next_e - 1天`(展示为下周日) |
| `${GEN_TIME}` | `TZ=Asia/Shanghai date "+%Y-%m-%d %H:%M"` |

---

## 撰写约束(7 条硬规则,严格遵守)

1. **关键数据行 4 个数字必须直接用 JSON `summary.{task_done, task_progress, bug_resolved, bug_active}`**,严禁自己重数。

2. **任务列表段**:
   - 每行使用 `tasks_done[*].display_path` 或 `tasks_progress[*].display_path`(已拼好父子前缀,直接用)
   - 行尾必须带状态后缀 `【{status_cn}】`,字段直接来自 JSON
   - 父子去重已在 collect 内消化,**不再展示父任务行**(渲染层不需做额外处理)
   - 完成与进行**不分两个子段**,状态在行末统一显示

3. **Bug 段**:
   - "已解决"列表 id 集合 == `bugs_resolved.map(.id)`
   - "待跟进"列表 id 集合 == `bugs_active.map(.id)`
   - 标题改写为可读中文(去命令行/路径/堆栈、保留业务语义,长度 ≤ 40 字),输入是 `title_raw`
   - 输出形如:`B51837 POS 下单接口空指针异常`

4. **Bug 根因 4 行表必须直接用 JSON `bug_root_cause` 的 4 个 key**:
   - 数量列:`bug_root_cause["代码缺陷"]` 等 4 个值
   - 占比列:数量 / `summary.bug_resolved` × 100%(取整)
   - 说明列:LLM 撰写一句话总结,可参考 `bugs_resolved` 中对应 type 的 title 关键词

5. **下周 OKR**:
   - 数据来源 = `tasks_next_week`(R4) ∪ `tasks_progress`(可作为延续项)
   - 按 P0/P1/P2 排,每档至少 1 行非占位
   - 任务名用业务表达,T 编号放后缀:`中差评跟踪处理/数据源配置 (T43919)`
   - 目标列写"动作 + 成效"句,**禁止**写状态字典("doing → done")
   - 禅道列三个标签:**进行中** / **未开始** / **暂无**
   - 见 § 叙述风格 §2 反例

6. **完成情况说明**:见 § 叙述风格 §1。
   - ✗ 不出现 T 编号
   - ✗ 不逐条复述任务
   - ✗ 不出现 zentao 状态词("doing/done/wait/pause"等)
   - ✓ 业务语言("VOC 评价能力补强"、"链路稳定性保障")
   - ✓ 概括数量、体现节奏判断
   - 长度 30~120 字

7. **任何提到的 id / 名字 / 数字必须能在 JSON 中找到**,严禁编造。AI Daily 引用必须有 frontmatter 出处日期。

---

## 自检 checklist(7 项 cross-check,3 轮上限)

写完 MD 后必须自跑。任一失败 → 改写 → 再跑。**断言已固化为脚本,LLM 不再手写检查**:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/skills/weekly-report/references/scripts/check-weekly.sh \
  /tmp/weekly-${WK_NUM}.md /tmp/weekly-${WK_NUM}.json
```

输出形如:
```
C1 ✓
C2 ✗ - MD 漏任务: T43317(parent=43820)
C3 ✓
C4 ✗ - 需求缺失 MD=1 JSON=0
C5 ✓
C6 ✓
C7 ✓
RESULT: 5/7 FAIL
```

退出码:`0` = 7/7 PASS,`1` = 任一 FAIL,`2` = 调用错误(MD/JSON 缺失或非法)。

### 7 项断言定义(脚本规范契约)

| # | 检查项 | 规则 |
|---|---|---|
| **C1** | 关键数据行 4 数字 | "本周关键数据"行的 4 数字 == `summary.{task_done, task_progress, bug_resolved, bug_active}` |
| **C2** | 任务列表 id 完整 | 对每个 `(tasks_done ∪ tasks_progress)` 任务,其 `id` 或 `parent_id`(若 > 0)至少一个出现在 MD 的 `【T\d+】` 中。`tasks` 全空时,MD 须含"暂无/节假日/假期/休息/缺勤"之一 |
| **C3** | Bug id 完整 | "**已解决:**" 段 B 编号集合 == `bugs_resolved.id`;"**待跟进:**" 段 == `bugs_active.id`;**任一为空时,该段内须含"暂无/节假日/假期"**(支持同行 `**已解决:** 本周暂无...` 写法)|
| **C4** | Bug 根因 4 行 | 表中 4 行数量 == `bug_root_cause` 4 个 key;4 数之和 == `summary.bug_resolved` |
| **C5** | 下周计划 P0/P1/P2 | 三档表格行均在,任务列非空且非 `...` / 占位文案 / 中文括号占位 |
| **C6** | 完成情况说明 | 长度 30~200 字;不含 `T\d+`;不含 zentao 状态词(`doing\|done\|wait\|pause` 词边界);**零产出周(`task_done + task_progress == 0`)必须含'暂无/节假日/假期/休息/缺勤'之一** |
| **C7** | 向外看 ≥ 2 条 | `^### \d+\.` 出现 ≥ 2 次,且每条含"外部动态"与"关联/启示"与"来源:";若声明 AI Daily 暂停采集/节假日则跳过 |

修改断言行为时只动 [`references/scripts/check-weekly.sh`](references/scripts/check-weekly.sh),本表为规范注释,SKILL.md 不另行实现。

### 失败处理

失败 → 改写指定段 → 进入下一轮。3 轮上限。3 轮全失败 → AskUserQuestion 让用户裁决。

### 不在自检范围

- 措辞质量(C6 仅保底"具体性",文采由人工 Step 5 判断)
- 标题改写偏离原意(LLM 自律,人工 spot-check)
- 任务/Bug 数字以 collect 输出为准 — collect 失败由 `_meta.skipped` 暴露

---

## 数据筛选硬约束(collect-weekly.js 已实现,此处仅作行为契约)

- **只统计本人**(`_account_assigned == me` 或 `_account_finished == me` / `_account_resolved == me`)
- **时间窗严格**:`tasks_done` 用 `finishedDate ∈ [wk_start, wk_end)`;`tasks_progress` 用 `lastEditedDate || assignedDate ∈ [wk_start, wk_end)`;`bugs_resolved` 用 `resolvedDate ∈ [wk_start, wk_end)`
- **`bugs_resolved` 必须 `?status=all`**,否则 closed bug 静默漏掉
- **`bugs_active` 不加 `?status=all`**,默认已只返活跃
- **父子去重**:某 task id 出现在其他 task 的 `parent_id` 中 → 该父 task 行被 collect 剔除
- **`.parent == -1`**:sentinel(自身是父),不要回查父
- **空数据时**:写"本周暂无 X",不编造数字;若是节假日缺勤需在"完成情况说明"注明

详见 [`references/data-schema.md`](references/data-schema.md)。

## 任务格式(参考)

- 子任务(`parent_id > 0`):`【T{parent_id}】{parent_name}/{name}` — collect 已拼好,放在 `display_path`
- 根任务(`parent_id == 0` 或 `-1`):`【T{id}】{name}` — collect 已拼好,放在 `display_path`
- Bug:`B{id} {LLM 改写后的可读中文标题}`(标题改写 → 去技术黑话、保留语义)

## status_cn 映射

| zentao status | 中文 |
|---|---|
| done | 已完成 |
| closed | 已关闭(或已发布,取决于业务习惯) |
| doing | 进行中 |
| wait | 未开始 |
| pause | 暂停 |
| cancel | 已取消 |

由 collect 输出 `status_cn` 字段,LLM 直接用。

---

## 异常处理

| 异常 | 退出码 | 处理 |
|---|---|---|
| `collect-weekly.js` 一般错误 | 1 | 中止主流程,echo stderr,提示检查 zentao 凭据 |
| 硬超时(10 min) | 4 | 看 `_meta.skipped` 哪些 endpoint 卡住,可调 `WEEKLY_HARD_TIMEOUT_MS` |
| **API budget 触顶**(数据残缺) | **5** | **partial JSON 已写盘但 stdout 不打 "OK"。按 stderr 提示设 `WEEKLY_API_BUDGET=4000`(或更高)重跑;调试场景可用 `--allow-partial` 或 `WEEKLY_ALLOW_PARTIAL=1` 绕过** |
| token 401 自动刷新失败 | 1 | `collect-weekly.js` 内已 spawnSync `zt_acquire_token`;仍失败需手动 `rm ~/.cache/zentao/token.json` 后再跑 |
| `summary` 字段缺失 | – | JSON 损坏,中止 Step 3,echo `cat /tmp/weekly-{WK_NUM}.json \| jq .` |
| 自检 3 轮不过 | – | AskUserQuestion 让用户决定:带瑕疵保存 / 重新生成 / 取消 |
| 本周禅道全空 | 0 | 生成"本周暂无 X"模板,`check-weekly.sh` 在 tasks/bugs 全空时要求 MD 含合规关键字 |
| AI Daily 无数据 | – | C7 跳过,正文写"本周适逢{节日},AI Daily 暂停采集" |
| 已存在本周周报 | – | 手动 dry-run 默认覆盖 `/tmp/weekly-{WK_NUM}.md`;Step 5 保存前再次确认是否覆盖知识库 |
| `git push` 失败 | – | `git pull --rebase` 后重试一次;仍失败上报用户,不要 `--force` |

---

## 渐进式深读

| 何时读 | 文件 |
|---|---|
| 看不懂 collect-weekly.js 输出的 JSON 字段 | [`references/data-schema.md`](references/data-schema.md) |
| 修改数据采集逻辑 | [`references/scripts/collect-weekly.js`](references/scripts/collect-weekly.js) |
| AI Daily 视野情报提炼规则 | [`references/ai-daily-digest.md`](references/ai-daily-digest.md) |
| 理解整体架构与设计动机 | 参照 `exp-compass-daily/SKILL.md` § 设计哲学(同款 V2 三层架构) |

---

## 文案规范

- 默认视角是本人,不显式写"青蛙"
- 不在正文解释筛选规则
- 语言偏正式周报风格,避免口语化
- Bug 标题整理成可读中文(去命令、去路径、保留业务语义)
- 完成情况说明 30~120 字,有判断,不流水账
- 向外看每条 = 外部动态 + 与我们的关联/启示,标注 AI Daily 来源日期

## 叙述风格(强约束)

LLM 渲染"完成情况说明"与"下周 OKR"时必须遵守,否则会被人工驳回。

### 1. 完成情况说明

**做什么**:从 `tasks_done` + `tasks_progress` 任务名归纳出**业务主线** + **覆盖范围** + **交付节奏**,3 句以内。把任务名抽象成"业务能力"语言。

**正例(W15)**:
> 本周主线是**新版VOC小程序后端开发交付**,6 个子任务全部完成,涵盖商品管理优化、数据源配置、配置/标签场景管理等功能模块,持续推进 voc 日常迭代的交付节奏。另完成宝洁回评模型效果优化 1 项。

**正例(W16)**:
> - 本周主线集中在 VOC 链路能力补强与问题排查,一方面推进平台对接和评价情感判断逻辑开发,另一方面补齐演示环境、列表展示和故障排查接口能力。
> - 从节奏上看,周中完成了情感标签与展示相关功能开发,周后段转向接口增强和问题定位,交付重心从单点需求实现延伸到链路稳定性保障。

**反例(避免)**:
> - 已完成两项后端交付:T43849"618大促VOC评价优化"后端实现于 04-28 节前 finish,...

(为什么是反例:堆 T 编号 + 时间戳 + 状态词,变成了任务流水账,不是周报。)

### 2. 下周 OKR

**做什么**:从 `tasks_next_week` + `tasks_progress` 挑 3~5 项,按 P0/P1/P2 排。每行有"任务名 / 目标 / 禅道"三列。

**正例(W16)**:
```
> 下周主要任务均来自禅道未完成/未开始任务,另补充两项本周未入禅道的问题修复。

| 优先级 | 任务 | 目标 | 禅道 |
|--------|------|------|------|
| P0 | 宝洁回评生成优化 | 优化宝洁品牌回评生成模型,提升回评准确率与生成质量 | 禅道中暂无(需新建) |
| P1 | 评价列表新增展示商品主图字段(T43538) | 完成前后端联调与上线 | 进行中 |
| P2 | 多个SKU同一商品链接商品卖点获取不准问题 | 修复 SKU 映射逻辑,确保卖点准确归属 | 禅道中暂无(需新建) |
| P2 | 修复评价方案配置模块商品名称为空的问题(T43545) | 定位根因并修复,确保商品名称正确展示 | 未开始 |
```

---

## 飞书摘要

写完保存后,生成简短摘要发飞书:

```
${WK_NUM} 工作周报

本周完成任务 ${task_done} 个 | 推进任务 ${task_progress} 个 | 解决 Bug ${bug_resolved} 个 | 待跟进 ${bug_active} 个

主线:
1. {主线 1}
2. {主线 2}

下周重点:
- P0: {最重要任务}
- P1: {第二重要}

详情:05-Reports/weekly/${WK_NUM}-工作周报.md
```

---

## 硬约束

- **token 不入日志**:`collect-weekly.js` 已实装 sanitize,SKILL 编排时也不打印 token
- **本机 dry-run 不写知识库**:产出到 `/tmp/weekly-{WK_NUM}.md`,Step 5 人工确认才落盘
- **数字必出自 JSON**:`summary` 与 `bug_root_cause` 是 ground truth,严禁 AI 自己重数
- **写入路径固定** `$KNOWLEDGE_LIB/05-Reports/weekly/${WK_NUM}-工作周报.md`,用 `cp` 工具(不用 obsidian-cli);`KNOWLEDGE_LIB` 必须由各环境的 `.env` 设置,无 default
- **禁止 `git push --force`**:冲突时 `pull --rebase` 重试,仍失败上报用户
