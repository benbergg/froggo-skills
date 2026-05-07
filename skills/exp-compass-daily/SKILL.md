---
name: exp-compass-daily
description: "体验罗盘-每日研发进度播报。从禅道采集单产品(默认 95 VOC)的需求/任务/Bug,AI 在对话内按 4 段模板撰写日报,跑 6 项数据自检,人工预览确认后推送钉钉 OA 日志。触发词:体验罗盘、体验罗盘日报、研发进度播报、每日播报、daily compass、研发日报、产研日报、daily report、禅道日报、今日进度、今日 Bug、今日需求、当日处理。"
---

# 体验罗盘-每日研发进度播报

> 依赖 [`zentao-api`](../zentao-api/SKILL.md) skill 的 token 缓存。
> 详细设计 [[20260507-体验罗盘日报-V2-设计文档]]。
> **核心理念**:脚本只做"禅道→标准 JSON"的转换,AI 看完整 JSON 自己写报告,自检后人工确认再推送。

## When to Use

触发词:**体验罗盘、体验罗盘日报、研发进度播报、每日播报、daily compass、研发日报、产研日报、daily report、禅道日报、今日进度、今日 Bug、今日需求、当日处理**。

`user-invocable: true`。手动模式由用户触发,推送钉钉前必须 AskUserQuestion 确认。

## 必填环境变量

| 变量 | 说明 |
|---|---|
| `ZENTAO_BASE_URL` | 例 `https://chandao.bytenew.com/zentao/api.php/v1` |
| `ZENTAO_ACCOUNT` | 禅道账号 |
| `ZENTAO_PASSWORD` | 禅道密码 |
| `DINGTALK_APPKEY` | 企业内部应用 AppKey |
| `DINGTALK_APPSECRET` | AppSecret |
| `DINGTALK_USERID` | 创建日志的 userid(显示为提交人) |
| `DINGTALK_TEMPLATE_ID` | 钉钉日志模板 report_code |

可选:`ZENTAO_PRODUCTS`(默认 `95`)、`EXP_COMPASS_API_BUDGET`(默认 `300`)、`DINGTALK_TO_CHAT` / `_TO_USERIDS` / `_TO_CIDS`、`DRY_RUN=1`。

凭据加载:`set -a; source ~/.openclaw/.env 2>/dev/null || source ~/.zentao.env; set +a`

## 主流程(Step 0-5)

### Step 0 Setup

```bash
set -a; source ~/.openclaw/.env 2>/dev/null || source ~/.zentao.env 2>/dev/null || true; set +a
```

校验 4 个钉钉 env(缺则在 Step 4 前停下并 echo 缺哪些)。

### Step 1 数据采集

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/exp-compass-daily/references/scripts/collect.js \
  --product ${ZENTAO_PRODUCTS:-95} \
  --date $(date +%Y-%m-%d) \
  --out /tmp/exp-compass-$(date +%Y-%m-%d).json
```

失败 → 退出,提示用户检查禅道凭据。成功后输出文件路径。

### Step 2 AI 撰写

1. `Read("/tmp/exp-compass-{DATE}.json")` 整体读
2. 按 § 模板原文 + § 撰写约束在对话内生成完整 Markdown
3. `Write` 到 `~/Knowledge-Library/05-Reports/daily/{DATE}.md`(已存在则覆盖,后续由用户在 Step 4 决定是否回滚)
4. 在对话中 echo 整篇 MD 让用户预览

### Step 3 AI 自检(必须跑)

按 § 自检 checklist 跑 C1-C6,最多 3 轮:
- 全过 → 进入 Step 4
- 有失败 → 在对话中列出失败项 + 改写 MD + 再跑
- 3 轮全失败 → AskUserQuestion 让用户裁决:`带瑕疵推送 / 重新生成 / 取消`

每轮失败原因都要 echo 给用户看(透明)。

### Step 4 人工确认(必须用 AskUserQuestion)

```
question: "数据自检全过(或 3 轮失败).推送钉钉 OA 日志吗?"
options:
  - 推送
  - 让我改写指定段后重新走 Step 3
  - 取消(不推送,保留 MD 在知识库)
```

### Step 5 推送

仅在 Step 4 选"推送"时执行:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/exp-compass-daily/references/scripts/push-dingtalk.js \
  --date $(date +%Y-%m-%d)
```

成功 echo `report_id`;失败 echo 完整 errcode + errmsg,不自动重试。

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
   | 完成任务 | `(stories[].tasks ∪ loose_tasks).filter(is_today_finished)` | `finishedBy` |
   | 修复 Bug | `bugs.filter(is_today_closed \|\| is_today_resolved)` | `closedBy ?? resolvedBy` |
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

   不允许把"一、"改成"1.",不允许加 emoji 前缀,不允许前后多空格。`push-dingtalk.js` 段切片依赖此精确匹配。

---

## 自检 checklist(6 项 cross-check,3 轮上限)

写完 MD 后必须自跑。任一失败 → 改写 → 再跑。

| # | 检查项 | 验证方法 |
|---|---|---|
| **C1** | 概览表数字 | grep MD 中的 `\| 需求 \| ... \|` 等 3 行,共 12 个数字与 `summary.{story\|task\|bug}.{in_progress\|today_new\|today_done\|todo}` 严格相等 |
| **C2** | 需求推进段覆盖 | MD 中 `### S{id}` 提到的 id 集合 == `stories.filter(stage ∈ {developing,developed,tested}).map(.id)` |
| **C3** | 今日产出 6 段完整性 | 6 段中每段 id 集合 ⊇ JSON 对应 filter 结果 |
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

- 措辞质量(C6 仅保底"具体性",文采由人工 Step 4 判断)
- 时间一致性(${DATE} 已硬性绑定,无需再查)
- API 字段缺失(collect.js 已校验)
- H1 锚点正确性(写入约束 #6 已规定;若错则 push 时段切片失败暴露)

---

## 异常处理

| 异常 | 处理 |
|---|---|
| `collect.js` 退出非 0 | 中止主流程,echo stderr,提示检查 zentao 凭据 |
| Token 401 自动刷新失败 | `collect.js` 已退出,提示用户在终端跑 `zt_init && zt_acquire_token` |
| `summary` 字段缺失 | JSON 损坏,中止 Step 2,echo `cat /tmp/exp-compass-{DATE}.json \| jq .` |
| 自检 3 轮不过 | AskUserQuestion 让用户决定:带瑕疵推 / 重生成 / 取消 |
| `push-dingtalk.js` `gettoken` 失败 | exit 2,提示检查 AppKey/Secret |
| `push-dingtalk.js` `create_report` 失败 | exit 3,echo 完整 `errcode + errmsg`,不自动重试 |
| 钉钉模板字段不匹配 | 由 errmsg 暴露,提示人工调整 `template_id` 或检查 H1 锚点 |

---

## 渐进式深读

| 何时读 | 文件 |
|---|---|
| 看不懂 collect.js 输出的 JSON 字段 | [`references/data-schema.md`](references/data-schema.md) |
| 修改钉钉推送行为 | `references/scripts/push-dingtalk.js` |
| 修改数据采集逻辑 | `references/scripts/collect.js` |
| 理解整体架构与设计动机 | [[20260507-体验罗盘日报-V2-设计文档]] |

---

## 硬约束

- **不直接调禅道 `/tokens` API**(违反 DRY,token 由 zentao-api skill 维护)
- **manual 模式必须人工预览** + AskUserQuestion 确认才推送钉钉
- **数字必出自 collect.js JSON**:summary 是 ground truth,严禁 AI 自己重数
- **token 不入日志**:`collect.js` 已实装 sanitize,SKILL 编排时也不打印 token
- **写入路径固定** `~/Knowledge-Library/05-Reports/daily/{DATE}.md`,用 Write 工具(不用 obsidian-cli)
- **H1 锚点字符级精确**:见撰写约束 #6
