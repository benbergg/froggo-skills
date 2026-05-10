---
name: dingtalk-log
description: "通用钉钉日志 OpenAPI 封装。提供 create-report / save-content / get-template / list-templates / get-user 5 个 CLI 子命令,token 自管缓存,token 失效自动重取。触发词:钉钉日志、ding log、dingtalk report、dingtalk-log、钉钉日报推送、钉钉模板查询、钉钉用户查询。"
---

# DingTalk Log

## Overview

通用钉钉日志 OpenAPI 封装层。单文件 Node.js CLI(零依赖),覆盖 5 个端点:

| 子命令 | 钉钉端点 | 用途 |
|---|---|---|
| `create-report` | `POST /topapi/report/create` | 创建日志(填好的最终日志) |
| `save-content` | `POST /topapi/report/savecontent` | 暂存日志内容(用户进入页面再拉取) |
| `get-template` | `POST /topapi/report/template/getbyname` | 按模板名查模板字段、默认接收群、template_id |
| `list-templates` | `POST /topapi/report/template/listbyuserid` | 列用户可见模板(分页) |
| `get-user` | `POST /topapi/v2/user/get` | 查用户详情(完整字段) |

## When to Use

- 业务 skill 需要推送日志到钉钉(自己组装 contents 数组)
- 调试钉钉日志接口(查模板字段、查用户)
- cron / CI 集成(已支持 retry token + 60s 硬超时)

不适用:markdown 切片、模板字段对账(那是业务层职责)。

## Quick Start

```bash
# 1. 配置 OS 环境变量(详见 references/credentials.md)
export DINGTALK_APPKEY="dingxxxxx"
export DINGTALK_APPSECRET="xxxxxxxxxx"
export DINGTALK_USERID="staff_xxx"

# 2. 跑 list-templates 验证(读 API)
node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js list-templates --size 5

# 3. 创建日志(写 API)
node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js create-report \
  --template-id tpl_xxx \
  --userid u9 \
  --contents '[{"key":"今日完成工作","sort":"0","type":"1","content_type":"markdown","content":"hello"}]'
```

## 子命令速查

详细参数与返回值见 [references/api-spec.md](references/api-spec.md)。

| 子命令 | 必选 flag | 可选 flag |
|---|---|---|
| `create-report` | `--template-id` `--contents` `--userid`(可由 env 兜底) | `--dd-from` `--to-chat` `--to-userids` `--to-cids` `--dry-run` |
| `save-content` | `--template-id` `--contents` `--userid` | `--dd-from` `--dry-run` |
| `get-template` | `--template-name` `--userid` | — |
| `list-templates` | — | `--userid` `--offset` `--size` `--all` |
| `get-user` | `--userid` | `--language` |

## Exit Codes

| code | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 用户输入错误 |
| 2 | gettoken 失败 |
| 3 | create-report / save-content 失败 |
| 4 | get-template 失败 |
| 5 | list-templates 失败 |
| 6 | get-user 失败 |
| 7 | 硬超时(60s,优先于其他 code) |

## Safety Constraints

- **不接受 CLI 传入 appkey/appsecret**:仅从 env 读,防 history 泄露
- **stderr 凭据脱敏**:覆盖 query/JSON/Bearer 三种形态
- **token 缓存权限**:文件 600,父目录 700,原子 rename 写防半截 JSON
- **--all 50 页硬上限**:防恶性 cursor 死循环

## When to Read Which Reference

| 场景 | 读 |
|---|---|
| 第一次配置 / cron 注入凭据 | [references/credentials.md](references/credentials.md) |
| 调用前查 flag/返回值/errcode | [references/api-spec.md](references/api-spec.md) |
| 跑测试 / 加测试 | [tests/scenarios.md](tests/scenarios.md) |
| 完整设计动机与决策记录 | [[20260510-钉钉日志-skill-v1-设计文档]] |
