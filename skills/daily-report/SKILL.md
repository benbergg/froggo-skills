---
name: daily-report
description: "产研日报自动生成。从禅道采集指定产品的需求(进行中/今日完成/未分配/未执行四态)、Bug、关联任务,按需求-任务详情-Bug 表格-小结模式生成 Markdown,写入 Knowledge-Library/05-Reports/daily/,git push,推送飞书摘要。触发词:禅道日报、研发日报、daily report、产研日报、今日进度、今日 Bug、今日需求、当日处理。"
---

# 产研日报自动生成

> 依赖 [`zentao-api`](../zentao-api/SKILL.md) skill 进行禅道数据采集(6 snippet)。
> 详细设计 [[20260505-禅道日报-V1-设计文档]]。

## When to Use

触发关键词:**禅道日报、研发日报、产研日报、daily report、今日进度、今日 Bug、今日需求、当日处理**。

`user-invocable: true`,可手动 dry-run([`references/local-verify.md`](references/local-verify.md));后期 openclaw cron 接入。

## 环境变量

详见 [设计文档 §3.3](#),关键:

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `ZENTAO_BASE_URL` / `ZENTAO_ACCOUNT` / `ZENTAO_PASSWORD` | ✓ | - | 复用 zentao-api |
| `ZENTAO_PRODUCTS` | – | `95` | 产品 ID 列表;`all` 取 view.products |
| `ZENTAO_ROLE_MAP` | – | `~/.zentao-roles.yaml` | 角色映射 |
| `DAILY_TASK_LIMIT` | – | `500` | 范围内任务降级阈值 |
| `DAILY_API_BUDGET` | – | `600` | 调用预算硬上限 |
| `FEISHU_DAILY_WEBHOOK` | – | - | 飞书摘要 |
| `FEISHU_ALERT_WEBHOOK` | – | - | cron 失败告警 |
| `KNOWLEDGE_LIB` | – | `~/Knowledge-Library` | 输出根 |

凭据:生产 `~/.openclaw/.env`;本地 `~/.zentao.env`。

## 流程

```
Step 0  Setup        zentao-api 6 snippet + .env + 计 API 预算
Step 1  准备          DATE/TODAY_START;查重(cron 跳过/手动落 /tmp/)
Step 2  禅道采集      D1-D5(限流退避 + 预算计数 + 单产品超时熔断)
Step 3  角色 & 进度   yq/python 解析 role-map + 每需求 P4 进度 + 范围内任务降级
Step 4  聚合 & 生成   aggregate.sh → render.sh + 飞书摘要
Step 5  评测          ≥ 70 分,否则迭代 1 轮;失败 draft + 告警
Step 6  保存推送      写 KNOWLEDGE_LIB/05-Reports/daily/ → git add/commit/push
Step 7  飞书摘要      POST DAILY_WEBHOOK;cron 失败必再 POST ALERT_WEBHOOK
```

主入口:`bash references/scripts/run.sh [manual|cron]`。

## Setup(每次会话起手)

```bash
# 1. 加载凭据
set -a; source ~/.openclaw/.env 2>/dev/null || source ~/.zentao.env; set +a

# 2. eval zentao-api 6 snippet(从 zentao-api/references/quickstart.md ```bash 块复制)
zt_init && zt_acquire_token >/dev/null

# 3. 跑日报
bash skills/daily-report/references/scripts/run.sh manual
```

## 渐进式深读

| 何时读 | 文件 |
|---|---|
| 数据采集 D1-D5 | [`references/data-collection.md`](references/data-collection.md) |
| 角色映射 + YAML 解析 | [`references/role-mapping.md`](references/role-mapping.md) |
| 进度 P4 算法 | [`references/progress-calc.md`](references/progress-calc.md) |
| Markdown 模板 + frontmatter | [`references/template.md`](references/template.md) |
| 评测 8 维度 + source 调权 | [`references/evaluation.md`](references/evaluation.md) |
| 本机 dry-run + 部署前验证 | [`references/local-verify.md`](references/local-verify.md) |
| Rollback 操作 | [`references/rollback.md`](references/rollback.md) |

## 数据筛选硬约束

- **需求范围**:进行中 + 今日完成 + 未分配 + 未执行(stage=wait 子分两态);早前 closed/released **不展示**。
- **时间窗**:`[TODAY_START, NOW]` 闭开区间。
- **Bug**:`?status=all` 必加(否则漏 closed)。
- **任务**:`task.children[]` 必递归。
- **角色**:account 不在 `~/.zentao-roles.yaml` 任何 role → 标 `⚠️`。

## 任务/Bug/Story 格式

- 需求:`[[Sxxx]] 标题 · 创建人 @opener · 阶段 stage · 进度 [bar] N%(工时|数量|阶段)`
- 任务:`emoji [[Txxx]] 名 · 执行人 @assignee · ⏸/🔄/✅ status (已耗 Nh / 剩余 Nh)`
- Bug:表格 5 列 + `今日动态` 单独列

## 异常处理

详见 [设计文档 §9](#),关键:

| 异常 | 处理 |
|------|------|
| 401/Token 失效 | 自动重取重试 |
| 限流 429/503 | 指数退避(1/2/4/8s) |
| `API_CALL_COUNT >= BUDGET` | 熔断,partial + 告警 |
| 单产品超时 | 该产品熔断,其他继续 |
| 范围内任务 ≥ LIMIT | 降级,只列需求 |
| evaluation < 70 | 不保存,迭代 1 轮 |
| git push 失败 | `pull --rebase` 重试,cron 失败必告警,**不强推** |

## 文案规范

- 中文标题,无技术黑话
- 数字必来自禅道 API
- "今日变化"全空 → "今日暂无变化"
- 默认产品/团队视角(非个人)
- unknown 账号统一 `⚠️` 后缀

## 硬约束

- **不直接调 zentao-api lib**(V3 已废)
- **dry-run 不写知识库**:`/tmp/daily-${DATE}.md`,人工 review
- **evaluation 阻断闸**:< 70 不保存
- **禁止编造**:数字必出自 API
- **token 不入日志**
- **git push 失败不强推**;cron 必告警
- **YAML 禁纯 bash 解析**(yq / python3 必须)
- **`?status=all` 必加**:Bug 查询缺少此参数会漏掉 closed 状态
