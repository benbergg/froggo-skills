---
name: weekly-report
description: "产研周报自动生成。从禅道采集本周完成任务/解决 Bug/待跟进 Bug/下周计划,结合 AI Daily 视野情报,按模板生成周报写入 Knowledge-Library/05-Reports/weekly/,git push,发送飞书摘要。触发词:周报、研发周报、产研周报、weekly report、青蛙周报、本周完成、本周 Bug、下周计划。"
---

# 产研周报自动生成

> 依赖 [`zentao-api`](../zentao-api/SKILL.md) skill 进行禅道数据采集。
> 本 skill 不直接调用 lib(V3 已废 lib),所有禅道访问走 `zentao-api/references/quickstart.md` 的 6 个 bash snippet。

## When to Use

触发关键词:周报、研发周报、产研周报、weekly report、青蛙周报、本周完成的任务、本周解决的 Bug、本周待跟进 Bug、下周计划。

`user-invocable: true`,可手动 dry-run([`references/local-verify.md`](references/local-verify.md));也可由 openclaw cron `0 18 * * 6` 自动触发。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ZENTAO_BASE_URL` | ✓ | 例 `https://chandao.bytenew.com/zentao/api.php/v1` |
| `ZENTAO_ACCOUNT` | ✓ | 登录账号(本人) |
| `ZENTAO_PASSWORD` | ✓ | 密码 |
| `ZENTAO_ME` | – | 缺省取 `/user.profile.account`;周报筛选以本人为准 |
| `KNOWLEDGE_LIB` | – | 缺省 `~/Knowledge-Library`,周报输出根目录 |
| `AI_DAILY_DIR` | – | 缺省 `$KNOWLEDGE_LIB/08-Research/AI-Daily/Daily`,AI Daily 源目录 |

生产凭据放 `~/.openclaw/.env`;本地 dry-run 用 `~/.zentao.env`。详见 [`references/local-verify.md`](references/local-verify.md)。

## 流程

```
Step 0  Setup         eval zentao-api 6 snippet + 加载 .env
Step 1  准备           计算 YYYY-WXX、周一/周日日期;查重已存在则跳过
Step 2  禅道采集       data-collection.md 五块:R1-R5
Step 3  AI Daily 摘要  ai-daily-digest.md,读最近 7 天提炼 2~3 条
Step 4  生成           按 template.md 填四板块 + 命名约定
Step 5  评测           evaluation.md 自动检查 ≥ 80 分,否则迭代不保存
Step 6  保存推送       写 KNOWLEDGE_LIB/05-Reports/weekly/ + git commit/push
Step 7  飞书摘要       按 template.md §飞书摘要 输出
```

## Setup(每次会话起手)

```bash
# 1. 加载凭据
set -a; source ~/.openclaw/.env 2>/dev/null || source ~/.zentao.env; set +a

# 2. eval zentao-api 6 snippet(S1-S6)
#    把 references/quickstart.md 中 ```bash 块全部复制到当前 shell
#    (或用一行 sed:见 references/local-verify.md §1)
zt_init && zt_acquire_token >/dev/null
ME="${ZENTAO_ME:-$(zt_get /user | jq -r .profile.account)}"
zt_week_range   # 设 WK_START / WK_END / NEXT_S / NEXT_E (UTC ISO8601)
WK_NUM=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$WK_START" "+%G-W%V" 2>/dev/null \
       || date -d "$WK_START" "+%G-W%V")
export WK_NUM
echo "ME=$ME WK=$WK_NUM 本周=$WK_START~$WK_END 下周=$NEXT_S~$NEXT_E"
```

## 渐进式深读

| 何时读 | 文件 |
|---|---|
| 禅道采集脚本(R1-R5 → V3 P1/P2/P3) | [`references/data-collection.md`](references/data-collection.md) |
| AI Daily 视野情报提炼 | [`references/ai-daily-digest.md`](references/ai-daily-digest.md) |
| 周报 Markdown 模板 + frontmatter | [`references/template.md`](references/template.md) |
| 评测标准 + 自动检查脚本 | [`references/evaluation.md`](references/evaluation.md) |
| 本机 dry-run + diff + 部署前验证 | [`references/local-verify.md`](references/local-verify.md) |

## 数据筛选硬约束

- **只统计本人**(account == `$ME`):任务 `assignedTo` 或 `finishedBy`、Bug `assignedTo`/`resolvedBy`/`openedBy`(看场景)。
- **时间窗严格闭区间** `[WK_START, WK_END]`(本周一 00:00 ~ 本周日 23:59:59),用 jq `>=` / `<` 实现。
- **排除**:仅开始无产出、仅编辑无产出、他人完成、与本人无关的动态。
- **空数据时**写"本周暂无 X",不编造数字;若是节假日缺勤需在"完成情况说明"注明。

## 任务格式

- 有父子(`.parent > 0`):`【T{父ID}】{父任务名}/{子任务名}` — 父 ID 通过 V3 P3 二次回查。
- 无父子(`.parent == 0` 或 `-1`):`【T{任务ID}】{任务名}`
- Bug:`B{BugID} {整理后的可读中文标题}`(标题改写 → 去技术黑话、保留语义)

## 异常处理

| 异常 | 处理 |
|---|---|
| 禅道登录失败/token 失败 | 检查 `~/.openclaw/.env` 三变量;通知用户,不生成周报 |
| `zt_get` 401 | snippet 已自动重取 token 重试一次,仍失败则 `rm ~/.cache/zentao/token.json` 后再 `zt_acquire_token` |
| PUT 任务/Bug action 静默 no-op | V3 已知问题,改用 POST(详见 zentao-api/troubleshooting.md §11) |
| `.parent` 字段为 -1 | 该任务自身是父任务,**不要**回查父(sentinel,详见 zentao-api/troubleshooting.md §11.1) |
| 本周禅道全空 | 生成"本周暂无 X"模板,但 evaluation 仍要 ≥ 80 分(评分会按节假日/缺勤情况调权,见 evaluation.md) |
| AI Daily 无数据 | 向外看注明"本周暂无 AI Daily 数据"(扣 10 分,需人工补) |
| 已存在本周周报 | cron 自动执行时跳过;手动 dry-run 写到 `/tmp/`,不覆盖知识库 |
| `git push` 失败 | `git pull --rebase` 后重试;仍失败上报用户,不要 `--force` |
| evaluation < 80 | 不保存、不推送,把评测 issues 反馈给生成步骤,最多迭代 2 轮;再失败上报用户 |

## 文案规范

- 默认视角是本人,不显式写"青蛙"
- 不在正文解释筛选规则
- 语言偏正式周报风格,避免口语化
- Bug 标题整理成可读中文(去命令、去路径、保留业务语义)
- 完成情况说明 2~3 句,有判断不流水账
- 向外看每条 = 外部动态 + 与我们的关联/启示,标注 AI Daily 来源日期

## 硬约束

- **不直接调用 zentao-api 的 lib**:V3 已废,必须走 quickstart.md 6 snippet。
- **本机 dry-run 不写知识库**:输出到 `/tmp/weekly-${WK_NUM}.md`,人工 review 通过才落盘。
- **evaluation 是阻断闸**:< 80 分不保存,防止劣质周报污染知识库。
- **禁止编造**:任务/Bug 数字必须来自禅道 API;AI Daily 引用必须有 frontmatter 出处。
