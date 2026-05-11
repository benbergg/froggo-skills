---
name: dingtalk-log
description: "通用钉钉日志 OpenAPI 封装。提供 create-report / save-content / get-template / list-templates / get-user 5 个 CLI 子命令,token 自管缓存,token 失效自动重取。触发词:钉钉日志、ding log、dingtalk report、dingtalk-log、钉钉日报推送、钉钉模板查询、钉钉用户查询。"
---

# DingTalk Log

## Overview

通用钉钉日志 OpenAPI 封装层。单文件 Node.js CLI(零依赖),覆盖 5 个端点:

| 子命令 | 钉钉端点 | 用途 |
|---|---|---|
| `create-report` | `POST /topapi/report/create` | **创建一条日志(写入 APP 我的日志)**。**默认 `to_chat=false`(无广播,safe default)**,只写入 userid 的"我的日志";要群里收到通知,**必须** `--to-chat true` **同时** 显式注入 `--to-cids` / `--to-userids`(钉钉不自动 fanout 模板 `default_received_convs`) |
| `save-content` | `POST /topapi/report/savecontent` | (设计意图)暂存日志内容供 APP 端拉取预填。⚠️ **2026-05-11 实战发现:钉钉 APP 不消费此端点**(返回 errcode=0 + saved_id 但模板写日志页面不预填,V3 设计文档 §4.1 已记录),**不推荐使用** |
| `get-template` | `POST /topapi/report/template/getbyname` | 按模板名查模板字段、默认接收群、template_id |
| `list-templates` | `POST /topapi/report/template/listbyuserid` | 列用户可见模板(分页) |
| `get-user` | `POST /topapi/v2/user/get` | 查用户详情(完整字段) |

## 如何选子命令(决策树)

```
"我要把内容写到钉钉"
        │
        ├── 已经确认要广播到群/接收人?
        │   → create-report --to-chat true \
        │       --to-cids '["cid1","cid2"]' \      # 必填(钉钉不自动 fanout default_received_convs)
        │       [--to-userids '["uid1"]']           # 可选 — 额外的个人接收人
        │     一般 cids 从模板 default_received_convs 取(调 get-template 查)
        │
        ├── 只想让 userid 本人看到, 不广播任何人(由本人在 APP 转发决定)?
        │   → create-report          (不传 --to-chat,代码默认 to_chat=false)
        │     这是"无广播日志(personal log)"模式 — safe default
        │
        └── 想"暂存草稿让用户在 APP 编辑后再发"?
            → 不可行。saveContent 端点钉钉 APP 不消费(已实测验证)
              改用上面的"无广播日志"模式,效果等价 + 可靠
```

**默认行为安全**:不传 `--to-chat` 时 `parseBoolFlag(undefined) === false`,日志仅写入 userid"我的日志",**不触达任何接收人**(见 `scripts/dingtalk-log.js:234`)。要广播必须**显式**传 `--to-chat true`,这是"误广播预防"的代码层默认。`--to-chat false` 也明确无广播。

**⚠️ 广播 ≠ to_chat=true 单独生效**:钉钉 OpenAPI 实测 `to_chat=true` + 空 `to_cids`/`to_userids` **不会**触发群通知(日志只会进 userid"我的日志",和无广播模式无可见差别)。要群里收到通知,**必须显式注入** `--to-cids '[...]'`(从模板 `default_received_convs[].conversation_id` 取)或 `--to-userids '[...]'`(2026-05-11 exp-compass-daily backtest 实证)。

**调试**:用 `--dry-run` flag(create-report / save-content 子命令支持)输出预期 payload JSON 并 exit 0,不真调 OpenAPI。**env `DRY_RUN` 无效**,仅 `--dry-run` flag 生效。

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

# 3a. 创建一条"无广播日志(personal log)" — safe default
# 不传 --to-chat 时 to_chat=false,内容只在 userid 的 APP 我的日志可见,不触达任何人
node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js create-report \
  --template-id tpl_xxx \
  --userid u9 \
  --contents '[{"key":"今日完成工作","sort":"0","type":"1","content_type":"markdown","content":"hello"}]'

# 3b. 创建并广播(必须 --to-chat true + 显式 to_cids/to_userids,钉钉不自动 fanout default_received_convs)
TPL=$(node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js get-template \
  --template-name "模板名" --userid u9)
CIDS=$(echo "$TPL" | jq -c '[.result.default_received_convs[].conversation_id]')
node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js create-report \
  --template-id tpl_xxx \
  --userid u9 \
  --contents '[{"key":"今日完成工作","sort":"0","type":"1","content_type":"markdown","content":"hello"}]' \
  --to-chat true \
  --to-cids "$CIDS"

# 3c. dry-run 查 payload(不真调 OpenAPI,echo create_report_param JSON)
node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js create-report \
  --template-id tpl_xxx --userid u9 --contents '[...]' --to-chat true --to-cids "$CIDS" --dry-run
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
- **广播默认行为(代码层 safe default)**:`create-report` 不传 `--to-chat` 时 `to_chat=false`,日志只入 userid"我的日志",不触达任何接收人(`scripts/dingtalk-log.js:234` `parseBoolFlag` undefined-fallback)。要群里收到通知,**必须** `--to-chat true` **同时** 显式注入 `--to-cids` / `--to-userids`;**`to_chat=true` 单独不会自动 fanout 模板 `default_received_convs`**(钉钉 OpenAPI 实测,2026-05-11)

## When to Read Which Reference

| 场景 | 读 |
|---|---|
| 第一次配置 / cron 注入凭据 | [references/credentials.md](references/credentials.md) |
| 调用前查 flag/返回值/errcode | [references/api-spec.md](references/api-spec.md) |
| 跑测试 / 加测试 | [tests/scenarios.md](tests/scenarios.md) |
| 完整设计动机与决策记录 | [[20260510-钉钉日志-skill-v1-设计文档]] |
