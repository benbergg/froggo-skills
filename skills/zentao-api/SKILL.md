---
name: zentao-api
description: Use when querying or modifying Zentao via RESTful API. Triggers: 禅道/zentao、查任务/Bug/需求/产品/项目/迭代/执行/用户/版本/发布/计划/反馈/工单、创建/修改/开始/暂停/继续/完成/关闭任务、创建/解决/确认/激活/关闭Bug、创建/变更/关闭需求
---

# Zentao API

## Overview
通过禅道 RESTful API v1 进行**读 + 受控写**;**禁止 DELETE**(设计层面不暴露)。

## When to Use
- 查/写禅道实体(任务/Bug/需求/产品/项目/执行/用户等)
- 跨执行/产品聚合(本周完成、由我解决、按时间窗筛等)
- 排查反直觉端点行为(顶层 /tasks 残废、PUT 静默 no-op 等)

不适用:UI 自动化、Cookie session 调用、删除操作。

## Quick Start
1. 设置 env(`ZENTAO_BASE_URL` / `ZENTAO_ACCOUNT` / `ZENTAO_PASSWORD`)
2. `source` [scripts/zt-functions.sh](scripts/zt-functions.sh) 加载 6 个 zt_* 函数
3. `zt_init && zt_acquire_token >/dev/null` 验证连通
4. 调用:`zt_get` / `zt_paginate` / `zt_write`
5. 完整步骤、自检命令、env 详表 → [quickstart.md](references/quickstart.md)

## When to Read Which Reference
| 场景 | 读 |
|------|---|
| 调用前快速上手 | [quickstart.md](references/quickstart.md) |
| 查"某数据该调哪个端点" | [endpoints.md](references/endpoints.md) |
| 写聚合查询(跨执行/产品/父子) | [patterns.md](references/patterns.md) |
| 遇到反直觉行为 / 错误信号 | [troubleshooting.md](references/troubleshooting.md) |
| 部署后或换实例后端到端自检 | [verify.md](references/verify.md) |
| 看完整可执行脚本 | [examples/](examples/) |

## Safety Constraints
- **禁止 DELETE**:不暴露任何 DELETE 端点(设计层面)
- **`--noproxy '*'` 必加**:本机代理兜底返 400(zt-functions.sh 已默认)
- **JSON sanitize 必做**:`tr -d '\000-\037'` 清除未转义控制字符(zt-functions.sh 已默认)
- **顶层 `/tasks` 禁用**:`limit/page` 失效,必走 `/executions/{id}/tasks`
- **token 不入日志**:`token.json` 600 / `$cache` 700(zt-functions.sh 已默认)

## Common Mistakes
完整坑点见 [troubleshooting.md](references/troubleshooting.md)。**最高频 3 个**:
1. **task/bug action 用 PUT** → 静默 no-op、状态零变更;**全用 POST**
2. **`/executions/{id}/tasks` 不递归 `.children[]`** → 漏 60%+ 子任务
3. **`/products/{id}/bugs` 不加 `?status=all`** → 漏全部历史 closed bug
