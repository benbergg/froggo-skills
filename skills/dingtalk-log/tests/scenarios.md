# dingtalk-log BDD 场景库

> 28 条 mock 测试覆盖 5 个端点 + token + 输入边界 + 凭据脱敏 + 健壮性。
> 跑测试:`node --test tests/run-tests.js`

| # | 场景 | 测试 ID(run-tests.js 中) |
|---|---|---|
| B1 | 凭据缺失 → exit 1 | `B1: 凭据缺失 → exit 1 + stderr 列全缺失项` |
| B2 | userid env 兜底 | `B2: userid 来自 env 兜底(create-report dry-run)` |
| B3 | --userid 覆盖 env | `B3: --userid flag 覆盖 env` |
| B4 | --contents - stdin | `B4: --contents - 从 stdin 读` |
| B5a | @file 不存在 → exit 1 | `B5a: --contents @nonexistent → exit 1` |
| B5b | @file 正常读取 | `B5b: --contents @file → 正确读取` |
| B6 | contents 非数组 → exit 1 | `B6: contents 非数组 → exit 1` |
| B7 | --dry-run 0 fetch | `B7: --dry-run 打印 payload 且 0 fetch` |
| B8 | cache 命中 0 gettoken | `B8: token cache 命中 → 0 次 gettoken` |
| B9 | cache 过期重取 | `B9: token cache 过期 → 调 gettoken 1 次 + 业务 1 次` |
| B10 | token 重取 retry-once 成功 | `B10: 业务 errcode 42001 → 重取 token 后业务重试 = 0;fetch 总数 = 3` |
| B11 | token 重取 retry-once 仍失败 | `B11: 重试后业务仍 42001 → exit 4 (get-template);fetch 总数 = 3,不再重试` |
| B12 | 非 token errcode 不重试 | `B12: 业务 errcode 88 不重试 → exit 4 + 1 业务调用` |
| B13 | 网络错误 + 凭据脱敏 | `B13: 网络错误 → exit 4 + stderr 不含明文凭据` |
| B14 | sanitize 三形态 | `B14: sanitize 三形态(query/JSON/Bearer)` |
| B15 | get-template 完整 result | `B15: get-template 完整 result 透传` |
| B16 | list-templates 单页 | `B16: list-templates 单页` |
| B17 | --all 翻页合并 | `B17: --all 翻页合并` |
| B18 | --size 截断 + WARN | `B18: --size 500 截断为 100 + WARN` |
| B19 | get-user 不脱敏 | `B19: get-user 不脱敏 mobile/email` |
| B20 | 业务 fetch 永不返 → 7 | `B20: 业务 fetch 永不返 → exit 7` |
| B21 | save-content 正常 | `B21: save-content happy path` |
| B22 | stdin TTY 拒绝 | `B22: stdin TTY 拒绝 (--contents -)` |
| B23 | 双 - 冲突 | `B23: 双 - 冲突` |
| B24 | cache 损坏不 crash | `B24: cache 损坏 → 当作 miss 不 crash` |
| B25 | --all 50 页上限 | `B25: --all 50 页上限` |
| B26 | --help 跳 env 校验 | `B26: --help 跳过 env 校验` |
| B27 | result 形态归一化 | `B27: result 形态归一化 (string vs object)` |
| B28 | gettoken 超时优先 | `B28: gettoken 永不返(cache miss) → exit 7 而非 2` |

## 怎么跑

```bash
cd skills/dingtalk-log
node --test tests/run-tests.js
```

期望:36 pass(包含 sanity / Issue-2 regression / 5 个 tokenCache 单元测试 / 28 条 BDD 编号场景)、0 fail、0 skip。

## E2E 可选

```bash
DINGTALK_E2E=1 \
DINGTALK_APPKEY=ding_xxx \
DINGTALK_APPSECRET=xxxxxxxx \
DINGTALK_USERID=staff_xxx \
node scripts/dingtalk-log.js list-templates --size 5
```

期望:`{"errcode":0,"result":{"template_list":[...]}}`。
