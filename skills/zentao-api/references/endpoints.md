# 禅道 v1 API 端点目录

> 按需载入。先看 [`SKILL.md`](../SKILL.md) 主文件,再读这里。涉及反直觉行为/偏差请同时参考 [`known-issues.md`](known-issues.md)。

## 0. 全 v1 入口图

```
入口（无前置 ID,可直接调）:
  /user  /users  /departments  /programs  /products  /projects
  /executions  /productplans  /testtasks  /feedbacks  /tickets

二级（需要上层 ID）:
  program → /programs/{id}/{products|projects}
  product → /products/{id}/{stories|bugs|plans|releases|cases}
  project → /projects/{id}/{stories|bugs|executions|builds|releases|testtasks}
  exec    → /executions/{id}/{stories|tasks|bugs|builds}    ★ tasks 唯一来源
  plan    → /productplans/{id}/{stories|bugs}
```

⚠️ 残废端点(API 存在但不可用):
- 顶层 `GET /tasks` — `limit`/`page` 失效,永远只返 1 条 → **禁用**,必须走 `/executions/{id}/tasks`
- `GET /products/{id}/bugs?status=resolved`/`closed`/其他单值 — 破坏查询(返 0)→ **唯一接受的值是 `?status=all`**(用于解锁默认隐式过滤的 closed bug)

⚠️ 隐式过滤陷阱(端点工作但默认漏数据,详见 known-issues §11.2/§11.3):
- `GET /executions/{id}/tasks` — 子任务藏在父对象的 `.children[]` 子数组,jq 必须递归
- `GET /products/{id}/bugs` — 默认过滤 `status != closed`,历史 closed bug 全漏,要加 `?status=all`

## 1. "已知什么 → 调什么"查找表

| 已知 | 想要 | 调用 |
|------|------|------|
| 什么都不知道 | 我的数据 | `/user` 拿 view 范围 |
| 什么都不知道 | 大盘 | `/products` / `/projects` / `/executions` |
| productId | 需求/Bug/计划/项目/用例/发布 | `/products/{id}/{stories\|bugs\|plans\|projects\|cases\|releases}` |
| projectId | 需求/Bug/迭代/版本/发布/测试单 | `/projects/{id}/{stories\|bugs\|executions\|builds\|releases\|testtasks}` |
| executionId | 任务/需求/Bug/版本 | `/executions/{id}/{tasks\|stories\|bugs\|builds}` |
| programId | 产品/项目 | `/programs/{id}/{products\|projects}` |
| productplanId | 该计划下需求/Bug | `/productplans/{id}/{stories\|bugs}` |
| taskId/bugId/storyId/userId/buildId | 详情 | 对应详情端点 |

## 2. 端点目录(按官方 17 章节)

### 2.1 用户(高频)

| 方法 | 路径 | 上层依赖 | 响应 list key | 备注 |
|------|------|---------|--------------|------|
| GET | `/user` | (顶层) | 单 obj | `profile.view` 含 `.sprints` `.products` `.projects` `.programs` ID 列表 |
| GET | `/users` | (顶层) | `.users` | 用户列表 |
| GET | `/users/{id}` | userId | 单 obj | 用户详情 |
| POST | `/users` | (顶层) | 单 obj | 创建用户(低频写入) |
| PUT | `/users/{id}` | userId | (无 list) | 修改用户(低频写入) |
| ❌ DELETE | `/users/{id}` | — | — | **本 skill 不暴露,设计层面禁止** |

### 2.2 部门(低频)

| 方法 | 路径 | 备注 |
|------|------|------|
| GET | `/departments` | 部门列表;字段细节见 https://www.zentao.net/book/api/665.html §2.3 |
| GET | `/departments/{id}` | 部门详情 |

### 2.3 项目集(低频)

| 方法 | 路径 | 备注 |
|------|------|------|
| GET | `/programs` | 项目集列表 |
| GET | `/programs/{id}` | 项目集详情 |
| GET | `/programs/{id}/products` | 项目集下产品列表 |
| GET | `/programs/{id}/projects` | 项目集下项目列表 |
| POST | `/programs` | 创建项目集(低频) |
| PUT | `/programs/{id}` | 修改项目集(低频) |
| ❌ DELETE | `/programs/{id}` | **不暴露** |

字段细节见 https://www.zentao.net/book/api/665.html §2.5。

### 2.4 产品(高频)

| 方法 | 路径 | 上层依赖 | 响应 list key | 备注 |
|------|------|---------|--------------|------|
| GET | `/products` | (顶层) | `.products` | 产品列表 |
| GET | `/products/{id}` | productId | 单 obj | 产品详情 |
| POST | `/products` | (顶层) | 单 obj | 创建产品;必填:`name`、`code`、`line`(产品线)、`type` |
| PUT | `/products/{id}` | productId | 单 obj | 编辑产品 |
| ❌ DELETE | `/products/{id}` | — | — | **不暴露** |

### 2.5 产品计划(低频)

| 方法 | 路径 | 备注 |
|------|------|------|
| GET | `/productplans` | 全部计划列表 |
| GET | `/productplans/{id}` | 计划详情 |
| POST | `/productplans` | 创建计划 |
| PUT | `/productplans/{id}` | 修改计划 |
| POST | `/productplans/{id}/stories` | 关联需求(link) |
| POST | `/productplans/{id}/bugs` | 关联 Bug(link) |
| ❌ DELETE | `/productplans/{id}` | **不暴露** |
| ❌ DELETE | `/productplans/{id}/stories` | unlink 操作,**不暴露** |
| ❌ DELETE | `/productplans/{id}/bugs` | unlink 操作,**不暴露** |

字段细节见 https://www.zentao.net/book/api/665.html §2.7。

### 2.6 发布(低频)

| 方法 | 路径 | 备注 |
|------|------|------|
| GET | `/products/{id}/releases` | 产品发布列表 |
| GET | `/projects/{id}/releases` | 项目发布列表 |

字段细节见 https://www.zentao.net/book/api/665.html §2.8。

### 2.7 需求(高频)

| 方法 | 路径 | 上层依赖 | 响应 list key | 备注 |
|------|------|---------|--------------|------|
| GET | `/products/{id}/stories` | productId | `.stories` | 产品需求列表 |
| GET | `/projects/{id}/stories` | projectId | `.stories` | 项目需求列表 |
| GET | `/executions/{id}/stories` | execId | `.stories` | 执行需求列表 |
| GET | `/stories/{id}` | storyId | 单 obj | 需求详情 |
| POST | `/stories` | (顶层) | 单 obj | 创建需求;必填:`product`、`title` |
| PUT | `/stories/{id}/change` | storyId | 单 obj | 变更需求(必填:`spec` `verify`) |
| PUT | `/stories/{id}` | storyId | 单 obj | 修改需求其他字段(PATCH 语义) |
| PUT | `/stories/{id}/close` | storyId | 单 obj | 关闭需求;必填 `reason` ∈ `done` / `cancel` / `bydesign` / `duplicate` / `postponed` / `willnotdo`(具体枚举以官方 729.html 为准,实施时 WebFetch 确认) |
| ❌ DELETE | `/stories/{id}` | — | — | **不暴露** |

> ⚠️ 端点路径 `/change` 是变更专用(改 spec/verify),`/{id}` PUT 是其他字段批量改 — 两者语义不同,见 https://www.zentao.net/book/api/665.html §2.9。

### 2.8 项目(高频)

| 方法 | 路径 | 上层依赖 | 响应 list key | 备注 |
|------|------|---------|--------------|------|
| GET | `/projects` | (顶层) | `.projects` | 项目列表 |
| GET | `/projects/{id}` | projectId | 单 obj | 项目详情 |
| POST | `/projects` | (顶层) | 单 obj | 创建项目;必填:`name`、`code`、`type`(execution/sprint/...)、`begin`、`end` |
| PUT | `/projects/{id}` | projectId | 单 obj | 修改项目 |
| ❌ DELETE | `/projects/{id}` | — | — | **不暴露** |

### 2.9 版本(低频)

| 方法 | 路径 | 备注 |
|------|------|------|
| GET | `/projects/{id}/builds` | 项目版本列表 |
| GET | `/executions/{id}/builds` | 执行版本列表 |
| GET | `/builds/{id}` | 版本详情 |
| POST | `/builds` | 创建版本 |
| PUT | `/builds/{id}` | 修改版本 |
| ❌ DELETE | `/builds/{id}` | **不暴露** |

字段细节见 https://www.zentao.net/book/api/665.html §2.11。

### 2.10 执行(高频)

| 方法 | 路径 | 上层依赖 | 响应 list key | 备注 |
|------|------|---------|--------------|------|
| GET | `/executions` | (顶层) | `.executions` | **支持 `?status=doing`**(几乎是唯一可信的服务端筛选参数) |
| GET | `/projects/{id}/executions` | projectId | `.executions` | 项目下执行列表 |
| GET | `/executions/{id}` | execId | 单 obj | 执行详情 |
| POST | `/executions` | (顶层) | 单 obj | 创建执行 |
| PUT | `/executions/{id}` | execId | 单 obj | 修改执行 |
| ❌ DELETE | `/executions/{id}` | — | — | **不暴露** |

### 2.11 任务(高频,**生产实例端点偏差强调**)

| 方法 | 路径 | 上层依赖 | 响应 list key | 必填 body | 备注 |
|------|------|---------|--------------|----------|------|
| GET | `/executions/{id}/tasks` | execId | `.tasks` | — | **唯一可用的任务列表端点**;⚠ **子任务藏在父对象 `.children[]` 子数组,jq 必须递归 `[.tasks[]?]+[.tasks[]?.children[]?]`**(详见 known-issues §11.2) |
| GET | `/tasks/{id}` | taskId | 单 obj | — | 任务详情(含 `.parent` 字段) |
| ❌ GET | `/tasks` | — | — | — | 顶层 `/tasks` 残废,limit 失效永远返 1 条 → **禁用** |
| POST | `/executions/{eid}/tasks` | execId | 新建 obj | `name` + `assignedTo` + `estStarted` + `deadline` | 创建任务;⚠ 官方文档说 `POST /tasks` 但**生产实例必须 `/executions/{eid}/tasks`**;`parent` 字段 POST 时被忽略;`assignedTo` 漏掉报 `『指派给』不能为空` |
| PUT | `/tasks/{id}` | taskId | (无 list) | — | 修改 module/story/name/type/assignedTo/pri/estimate/estStarted/deadline |
| POST | `/tasks/{id}/start` | taskId | — | `left` | wait → doing;⚠ 官方文档标 PUT,但 **PUT 返 200 + Content-Length: 0 静默 no-op**(V3 实测,见 known-issues §11)。**必须 POST** |
| POST | `/tasks/{id}/pause` | taskId | — | — | doing → pause;body 可含 `comment`;⚠ 同 start,PUT 静默 no-op |
| POST | `/tasks/{id}/restart` | taskId | — | `left`(实测还要 `consumed`) | pause → doing;⚠ 端点是 `/restart` 不是官方文档的 `/continue`(已实测确认,见 known-issues §"resume_task 实测必填 consumed") |
| POST | `/tasks/{id}/finish` | taskId | — | `currentConsumed`、`finishedDate` | → done;⚠ 同 start,PUT 静默 no-op |
| POST | `/tasks/{id}/close` | taskId | — | — | done → closed;body 可含 `comment`;⚠ 同 start,PUT 静默 no-op;⚠ **副作用:`assignedTo` 被清成 `null`**(`finishedBy`/`closedBy` 保留),客户端按 assignedTo 筛会漏 closed 任务 |
| POST | `/tasks/{id}/estimate` | taskId | — | `date[]` `work[]` `consumed[]` `left[]`(并行数组) | 添加工时日志;⚠ 端点是 `/estimate` 不是官方文档的 `/logs`(已实测) |
| GET | `/tasks/{id}/estimate` | taskId | (工时数组) | — | 取工时日志 |
| ❌ DELETE | `/tasks/{id}` | — | — | — | **不暴露** |

> 子任务创建必须**两步**:
> 1. `POST /executions/{eid}/tasks` 创建顶层任务(`parent` 字段被忽略)
> 2. `PUT /tasks/{newId}` body `{"parent": <parentId>}` 设父子关系
>
> 详见 known-issues §"创建子任务必须两步:POST + PUT"。

### 2.12 Bug(高频,**type/severity/pri/resolution 枚举完整**)

| 方法 | 路径 | 上层依赖 | 响应 list key | 必填 body | 备注 |
|------|------|---------|--------------|----------|------|
| GET | `/products/{id}/bugs` | productId | `.bugs` | — | 产品 Bug 列表;⚠ **默认隐式过滤 `status != closed`,要拉历史 closed bug 必须加 `?status=all`**(实测 product 95 default total=34 → `?status=all` total=1115);单值 `?status=resolved` 等返 0(详见 known-issues §11.3) |
| GET | `/bugs/{id}` | bugId | 单 obj | — | Bug 详情 |
| ❌ GET | `/bugs` | — | — | — | 顶层 `/bugs` 报 "Need product id.",必须按产品查 |
| POST | `/products/{pid}/bugs` | productId | 新建 obj | `title`、`severity`、`pri`、`type` | 创建 Bug;⚠ 官方文档说 `POST /bugs` 但**生产实例必须 `/products/{pid}/bugs`**;⚠ V3 实测时传入 `assignedTo` 跑通(类比创建任务的强约束),omit 未单独验证,稳妥起见传入 |
| PUT | `/bugs/{id}` | bugId | (无 list) | — | 修改 15 个字段 |
| POST | `/bugs/{id}/confirm` | bugId | — | — | body 可含 `comment`;⚠ 官方文档标 PUT,**PUT 返 200 静默 no-op**(V3 实测,见 known-issues §11)。**必须 POST** |
| POST | `/bugs/{id}/close` | bugId | — | — | body 可含 `comment`;⚠ 同 confirm,PUT 静默 no-op |
| POST | `/bugs/{id}/active` | bugId | — | — | ⚠ 端点是 `/active` 不是官方文档的 `/activate`(已实测);⚠ 同 confirm,PUT 静默 no-op |
| POST | `/bugs/{id}/resolve` | bugId | — | `resolution` | body 可含 `comment`;⚠ 同 confirm,PUT 静默 no-op |
| ❌ DELETE | `/bugs/{id}` | — | — | — | **不暴露** |

**枚举值**:

- `type`(创建必填):`codeerror` / `config` / `install` / `security` / `performance` / `standard` / `automation` / `designdefect` / `others`
- `resolution`(resolve 必填):`bydesign` / `duplicate` / `external` / `fixed` / `notrepro` / `postponed` / `willnotfix` / `tostory`
- `severity` / `pri`:V2 文档未明确列;按禅道社区版默认是 1-4 整数枚举(1=严重,4=最低)。具体以官方 https://www.zentao.net/book/api/722.html(创建 Bug)为准。
- `status`(只读):`active` / `resolved` / `closed`

> Bug "加备注"无独立端点;v1/v2 都没有。借 `confirm` / `close` / `active` / `resolve` 4 个 action 的 `comment` 字段附加。详见 known-issues §"Bug 加备注:无独立端点,须借 action 端点附带"。

### 2.13 用例(低频)

| 方法 | 路径 | 备注 |
|------|------|------|
| GET | `/products/{id}/testcases` | 产品用例列表;⚠ 官方文档写 `/cases`,**生产实例 V3 实测必须 `/testcases`**(`/cases` 返 `{"error":"not found"}`,见 known-issues §11) |
| GET | `/testcases/{id}` | 用例详情 |
| POST | `/testcases` | 创建用例 |
| PUT | `/testcases/{id}` | 修改用例 |
| POST | `/testcases/{id}/execute` | 执行用例 |
| ❌ DELETE | `/testcases/{id}` | **不暴露** |

字段细节见 https://www.zentao.net/book/api/665.html §2.15。

### 2.14 测试单(低频)

| 方法 | 路径 | 备注 |
|------|------|------|
| GET | `/testtasks` | 测试单列表;⚠ 官方文档写 `/testsuites`,**生产实例 V3 实测必须 `/testtasks`**(`/testsuites` 顶层报 `Need product id.`,要走 `/products/{id}/testsuites`,见 known-issues §11) |
| GET | `/projects/{id}/testtasks` | 项目下测试单 |
| GET | `/testtasks/{id}` | 测试单详情 |

字段细节见 https://www.zentao.net/book/api/665.html §2.16。

### 2.15 反馈(低频)

| 方法 | 路径 | 备注 |
|------|------|------|
| GET | `/feedbacks` | 反馈列表 |
| GET | `/feedbacks/{id}` | 反馈详情 |
| POST | `/feedbacks` | 创建反馈 |
| PUT | `/feedbacks/{id}` | 修改反馈 |
| POST | `/feedbacks/{id}/assign` | 指派反馈 |
| PUT | `/feedbacks/{id}/close` | 关闭反馈 |
| ❌ DELETE | `/feedbacks/{id}` | **不暴露** |

字段细节见 https://www.zentao.net/book/api/665.html §2.17。

### 2.16 工单(低频)

| 方法 | 路径 | 备注 |
|------|------|------|
| GET | `/tickets` | 工单列表 |
| GET | `/tickets/{id}` | 工单详情 |
| POST | `/tickets` | 创建工单 |
| PUT | `/tickets/{id}` | 修改工单 |
| ❌ DELETE | `/tickets/{id}` | **不暴露** |

字段细节见 https://www.zentao.net/book/api/665.html §2.18。

### 2.17 Token(认证)

| 方法 | 路径 | 备注 |
|------|------|------|
| POST | `/tokens` | 取 Token;body `{account, password}`;⚠ 官方文档写 `GET /token`,**生产实例是 `POST /tokens`**(已实测,见 known-issues) |

调用方式见 [`auth-and-curl.md`](auth-and-curl.md) S2 `zt_acquire_token`。

## 3. 通用查询参数白名单(实测)

| 参数 | 在哪些接口生效 |
|------|----------------|
| `limit` / `page` | 所有列表型端点 ✓;**唯独 `/tasks` 顶层失效** ✗ |
| `?status=` | `/executions` ✓(支持 doing/closed/all 等);`/products/{id}/bugs` **只接受 `all`**(其他值破坏查询返 0,默认值过滤 closed,见 known-issues §11.3) |
| `?assignedTo=` `?openedBy=` `?resolvedBy=` 等 | ✗ 大部分被忽略,统一改 jq 客户端筛(见 [`patterns.md`](patterns.md) P4) |

## 4. 高频调用链(简化,详细模板见 patterns.md)

| 业务场景 | 调用链 |
|----------|--------|
| 跨执行聚合任务(任意筛选) | `/user` → `view.sprints ∩ /executions?status=doing` → 遍历 `/executions/{sid}/tasks` → jq 筛(见 patterns.md P1) |
| 跨产品聚合 Bug/Story | `/user` → 遍历 `view.products` → `/products/{pid}/{bugs\|stories}` → jq 筛(见 patterns.md P2) |
| 父子任务还原 | `/tasks/{tid}` → `.parent` → `/tasks/{parent}`(见 patterns.md P3) |
