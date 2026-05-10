# DingTalk OpenAPI Reference

> 5 端点 + gettoken 字段速查。完整设计见 [[20260510-钉钉日志-skill-v1-设计文档]]。

## gettoken(内部使用)

- `GET https://oapi.dingtalk.com/gettoken?appkey=&appsecret=`
- 返回 `{errcode, access_token, expires_in}` (expires_in 单位秒,约 7200)

## create-report

- `POST https://oapi.dingtalk.com/topapi/report/create?access_token=`
- Body:
  ```json
  {
    "create_report_param": {
      "userid": "u9",
      "template_id": "tpl_xxx",
      "dd_from": "openapi",
      "contents": [{"key":"今日完成工作","sort":"0","type":"1","content_type":"markdown","content":"hello"}],
      "to_chat": false,
      "to_userids": [],
      "to_cids": []
    }
  }
  ```
- 返回 `{errcode, result}`,result 可能是 `"<id>"` 字符串或 `{report_id:"<id>"}` 对象,本 CLI 归一化为 `report_id`
- 关键约束:
  - `contents.key` 必须严格等于模板 `field_name`
  - `contents.sort` 是 0-based 字符串
  - 模板组件**仅支持** `type:"1"` + `content_type:"markdown"`(其他类型钉钉拒绝)
  - `to_chat=true` 单独不会推群,需配合 `to_cids`(从 get-template 拿 default_received_convs.conversation_id)

## save-content

- `POST https://oapi.dingtalk.com/topapi/report/savecontent?access_token=`
- Body 同 create-report,但**不要** `to_chat` / `to_userids` / `to_cids`
- 返回 `{errcode, result}`,result 是 saved_id 字符串

## get-template

- `POST https://oapi.dingtalk.com/topapi/report/template/getbyname?access_token=`
- Body: `{userid, template_name}`
- 返回 `{errcode, result: {id, fields[], default_received_convs[], default_receivers[]}}`
  - `fields[].field_name`(`contents.key` 必须等于此)
  - `fields[].sort`、`fields[].type`
  - `default_received_convs[].conversation_id`(用作 to_cids)

## list-templates

- `POST https://oapi.dingtalk.com/topapi/report/template/listbyuserid?access_token=`
- Body: `{userid?, offset, size}`(size ≤ 100)
- 返回 `{errcode, result: {template_list[], next_cursor?}}`
  - `template_list[].name`、`template_list[].report_code`(即 template_id)
- `--all` 在本 CLI 内部按 `next_cursor` 翻页,合并 template_list,50 页硬上限

## get-user

- `POST https://oapi.dingtalk.com/topapi/v2/user/get?access_token=`
- Body: `{userid, language?}` (`zh_CN` / `en_US`)
- 返回 `{errcode, result: {userid, name, mobile, email, title, role_list, dept_position_list, ...}}`

## 错误码

| errcode | errmsg | 处理 |
|---|---|---|
| 0 | ok | 成功 |
| 42001 | access_token expired | CLI 自动重取 + 重试 1 次 |
| 40014 | invalid access_token | 同上 |
| 41001 | access_token missing | 同上 |
| 33012 | 无效的 userId | 透传 |
| 400002 | 无效的参数 | 透传 |
| -1 | 系统繁忙 | 透传 |
