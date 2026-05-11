---
name: dingtalk-log
description: "通用钉钉日志 OpenAPI 封装。提供 create-report / save-content / get-template / list-templates / get-user 5 个 CLI 子命令,token 自管缓存,token 失效自动重取。触发词:钉钉日志、ding log、dingtalk report、dingtalk-log、钉钉日报推送、钉钉模板查询、钉钉用户查询。"
---

# DingTalk Log

## Overview

通用钉钉日志 OpenAPI 封装层。单文件 Node.js CLI(零依赖),覆盖 5 个端点:

| 子命令 | 钉钉端点 | 用途 |
|---|---|---|
| `create-report` | `POST /topapi/report/create` | **创建一条日志(写入 APP 我的日志)**。⚠️ 默认 `to_chat=true` 会触发 default_received_convs / to_userids / to_cids 广播,**必须显式传 `--to-chat false --to-userids "[]" --to-cids "[]"` 才能"无广播"** |
| `save-content` | `POST /topapi/report/savecontent` | (设计意图)暂存日志内容供 APP 端拉取预填。⚠️ **2026-05-11 实战发现:钉钉 APP 不消费此端点**(返回 errcode=0 + saved_id 但模板写日志页面不预填,V3 设计文档 §4.1 已记录),**不推荐使用** |
| `get-template` | `POST /topapi/report/template/getbyname` | 按模板名查模板字段、默认接收群、template_id |
| `list-templates` | `POST /topapi/report/template/listbyuserid` | 列用户可见模板(分页) |
| `get-user` | `POST /topapi/v2/user/get` | 查用户详情(完整字段) |

## 如何选子命令(决策树)

```
"我要把内容写到钉钉"
        │
        ├── 已经确认要广播给模板默认群/接收人? 
        │   → create-report (默认行为, 不传 --to-chat 即广播)
        │
        ├── 只想让 userid 本人看到, 不广播任何人(由本人在 APP 转发决定)?
        │   → create-report --to-chat false --to-userids "[]" --to-cids "[]"
        │     这是"无广播日志(personal log)"模式 — 推荐默认
        │
        └── 想"暂存草稿让用户在 APP 编辑后再发"?
            → 不可行。saveContent 端点钉钉 APP 不消费(已实测验证)
              改用上面的"无广播日志"模式,效果等价 + 可靠
```

**默认建议**:任何不确定要不要广播的调用,**先用无广播模式**(--to-chat false + 空 to_userids/to_cids)。这样 errcode=0 后由用户在 APP 我的日志看完决定是否手动转发,无误触发风险。

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

# 3a. 创建一条"无广播日志(personal log)" — 推荐默认模式
# 内容只在 userid 自己的 APP 我的日志里可见,不触达任何人
node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js create-report \
  --template-id tpl_xxx \
  --userid u9 \
  --contents '[{"key":"今日完成工作","sort":"0","type":"1","content_type":"markdown","content":"hello"}]' \
  --to-chat false --to-userids "[]" --to-cids "[]"

# 3b. 创建并广播(仅在明确要发给接收人/群时用)
node ${CLAUDE_PLUGIN_ROOT}/skills/dingtalk-log/scripts/dingtalk-log.js create-report \
  --template-id tpl_xxx \
  --userid u9 \
  --contents '[{"key":"今日完成工作","sort":"0","type":"1","content_type":"markdown","content":"hello"}]'
  # 不传 --to-chat 时默认 true,钉钉自动用模板的 default_received_convs 广播
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
- **广播默认行为**:`create-report` 不显式传 `--to-chat false` 时,钉钉自动用模板 `default_received_convs` 广播。**调用方有义务在不确定时显式传 `--to-chat false --to-userids "[]" --to-cids "[]"` 走无广播模式**,避免误推到群

## When to Read Which Reference

| 场景 | 读 |
|---|---|
| 第一次配置 / cron 注入凭据 | [references/credentials.md](references/credentials.md) |
| 调用前查 flag/返回值/errcode | [references/api-spec.md](references/api-spec.md) |
| 跑测试 / 加测试 | [tests/scenarios.md](tests/scenarios.md) |
| 完整设计动机与决策记录 | [[20260510-钉钉日志-skill-v1-设计文档]] |
