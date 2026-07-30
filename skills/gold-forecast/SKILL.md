---
name: gold-forecast
description: "黄金交易预测日报。确定性脚本从 LBMA/FRED/CFTC/东财采集数据并算出量化基线,MiniMax-M3 在基线上做调整并撰写七段报告,C1-C14 自检通过后入库、归档、推飞书;到期预测自动结算并记入三方对照(最终/基线/朴素)记分卡。触发词:黄金预测、金价预测、gold forecast、黄金日报、伦敦金、定盘价、黄金基线、黄金回测、黄金结算、金价区间。"
---

# 黄金交易预测日报

> 全自动流水线,**入口只有一个**:`node references/scripts/run.js`。
> 编排顺序、退出码策略、失败通知与修复循环状态全部由 `run.js` 持有 ——
> 那条顺序本身就是正确性约束(结算先于入库、校验先于入库),不放在本文档里靠人照做。

## When to Use

日常由 cron 每日触发,`run.js` 自行判断当天该不该跑(伦敦金假日不是周末的子集,
用 cron 的星期表达式表达必然出错)。手动场景:

| 场景 | 命令 |
|---|---|
| 首次部署后的历史回填 | `backfill.js`,见「部署」 |
| 基线参数标定 | `backtest.js`,见「部署」 |
| 演练一次不入库不推送 | `run.js --dry-run` |
| 补跑/重跑某一天 | `run.js --today YYYY-MM-DD` |

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `FRED_API_KEY` | ✓ | FRED 序列与发布日历。放 `~/.config/gold-forecast/env`(chmod 600,目录 700),**只经环境变量读入,绝不进命令行参数**——进程参数对同机其他进程可见 |
| `GOLD_FEISHU_TARGET` | ✓ | 飞书收件人 open_id。`push.js` **无默认值**,缺了直接退 1(误发比不发难收拾),`run.js` 会在开跑前就拦住 |
| `GOLD_ARCHIVE_DIR` | ✓ | 归档目录,例 `<知识库>/05-Reports/gold`。亦可用 `--archive-dir` |
| `GOLD_FEISHU_ACCOUNT` | – | 缺省 `helios`。本机装了多个飞书账号,open_id 按应用隔离,配错会被拒 `feishu_code=99992361 open_id cross app` |
| `GOLD_REPORT_URL_BASE` | – | 归档站点前缀,给推送摘要拼归档链接 |
| `SEND_NOTIFY` | – | 缺省 0 即**只演练不真发**;要真发必须显式设 1 |
| `OPENCLAW_BIN` | – | 缺省 `~/.npm-global/bin/openclaw` |
| `GOLD_RSYNC_BIN` | – | 覆盖 rsync 路径(非标准环境用) |

凭据一律由环境提供,本 skill 的任何文件里都不写真实值。

## 入口

```bash
# 日常(cron 用这条,注意 flock)
node references/scripts/run.js

# 演练:跳过入库与推送,其余照跑;验收标准是「各步产物齐备」
node references/scripts/run.js --dry-run

# 补跑指定日;显式给 --today 即人工意图,跳过「无新定盘则跳过」闸门(入库是 upsert,幂等)
node references/scripts/run.js --today 2026-07-29
```

参数:`--today` / `--dry-run` / `--state-dir` / `--archive-dir` / `--url-base`。

**退出码**:

| 码 | 含义 |
|---|---|
| 0 | `success` / `degraded_success` / `non_trading_day` |
| 3 | 已入库归档,但唯一恢复源(备份)失败。**预测本身完好**,修好后重跑 `commit.js` 即可 |
| 4 | 已入库,但飞书摘要没发出去 |
| 5 | 运行期异常(与「参数错=1」分开) |
| 6 | 流水线失败(`failed_before_settle` / `failed_after_settle`) |
| 7 | 基础设施失败(模型 API / 参数超长 / 环境异常) |

## 并发:必须用 flock 包住整个 run.js

`history-store` 的 upsert 是**无锁读-改-写**。两进程并发实测:同 key 各写 150 次、
应保留 300 条,五次运行只落 152/103/152/154/153 条,**无异常、无非 0 退出码**——
不加锁就是静默丢数据。库层刻意不加锁(那只是把编排层的问题伪装成已加固),
所以串行由调用方保证:

```bash
flock -n /tmp/gold-forecast.lock -c 'node ~/.openclaw/skills/gold-forecast/references/scripts/run.js'
```

`-n` 而非等待:上一次还没跑完就说明出了别的问题,排队只会让两次运行都撞在一起。

## 部署与回填(首次)

> 以下命令在运行主机上执行。回填要打外部 API,注意配额。

```bash
# 1. 同步 skill 到运行主机
rsync -a --delete skills/gold-forecast/ <host>:~/.openclaw/skills/gold-forecast/

# 2. 自测
ssh <host> 'cd ~/.openclaw/skills/gold-forecast && node --test tests/run-*-tests.js 2>&1 | tail -5'

# 3. 历史回填 —— since 必须给足 7 个完整日历年
ssh <host> '. ~/.config/gold-forecast/env; node ~/.openclaw/skills/gold-forecast/references/scripts/backfill.js \
  --history ~/.local/state/gold-forecast/history --since 2019-01-01 --until $(date -d yesterday +%F)'

# 4. 基线参数标定(walk-forward 回测)
ssh <host> 'node ~/.openclaw/skills/gold-forecast/references/scripts/backtest.js \
  --history ~/.local/state/gold-forecast/history --from 2019-01-01 --to $(date -d yesterday +%F) \
  --out ~/.local/state/gold-forecast/params.json'

# 5. 首次演练,确认各步产物齐备后再去掉 --dry-run
ssh <host> 'node ~/.openclaw/skills/gold-forecast/references/scripts/run.js --dry-run'
```

### `--since 2019-01-01` 不能改短

卡住样本量的**不是价格 spine**:`lbma-gold-pm.js` 的 fetchSeries 不按日期过滤,
`backfill.js` 对 `lbma_pm_usd` 传 `since: null`,所以价格是全量历史、`WARMUP=300` 不占预算。
真正的预算是**三特征的联合覆盖窗口**(FRED 按 `realtime_start`,COT 按日历年整年):

```
可评估条数 = 覆盖窗口 − 95(COT 分位 20 期周频爬坡) − 250(MIN_TRAIN) − 2n
```

实测覆盖 6.0 年 ⇒ long 周期只剩 1115 条,不足 1200 的验收下限;6.3 年才刚够。
留 7 个完整日历年 ⇒ 约 1910 交易日,余量约 325。**把窗口调短会让回测验收门槛静默失效**
(样本不足时门槛判不出差异,却不会报错)。

回测三期各自记录 `n` / `brier_gain` / `dm_p` / `passed`。**未通过的周期退化为 `p0_N`
是预期结果之一,不是失败**——那正是「基线只在证明得了自己的地方才上模型」的设计意图。

### cron

**默认不启用。** 先手动观察若干天的产出,确认无误后再由用户决定是否建定时任务;
建的时候按上面那条 `flock` 写法包住 `run.js`,并显式导出 `FRED_API_KEY` /
`GOLD_FEISHU_TARGET` / `GOLD_ARCHIVE_DIR` —— **cron 的环境不是登录 shell 的环境**。

## Step 4 写作规范摘要

完整契约在 `references/scripts/build-prompt.js` 的 `CONTRACT` 常量里,**判定在
`validate.js` 的 C1–C14**。此处只列要点,细则不在本文档复述以免两处走样:

- 输出 = 开头一个围栏 JSON 块(承载全部可判定字段)+ 其后七段中文正文,标题用「一、」至「七、」
- `prob_up` 一律是上涨概率,`direction` 由它派生(>0.5 为 up),二者必须一致
- 正文每个数字都要能在事实包 / 基线 / 统计校准里查到,或由白名单运算得出(容差 0.5%)
- 标 `missing` 的字段,正文不得出现相关论据
- 胜率 / Brier / Winkler 必须直接引用统计校准的数值,不得自算
- 新闻必须带链接,链接须来自新闻线索块
- **不给仓位、杠杆、买卖点位、止损价**——产品红线
- 偏离基线超阈值必须给出 `adjustment_reason` 并引用具体 facts 字段
- 第七段原样复制免责声明全文

自检未通过时 `run.js` 把 findings 连同上一轮原文喂回模型,**最多 3 轮**;
三轮仍不过则删掉这几轮产物、标 `degraded: true`、退化为只发布基线预测。
基线预测照发照结算,历史统计不断档。

## 故障排查

**`openclaw: command not found` / 模型步骤直接失败**
openclaw **不在非交互 shell 的 PATH 中**(实测 `ssh <host> 'which openclaw'` 失败)。
`run.js` 与 `push.js` 都用绝对路径 `~/.npm-global/bin/openclaw`,被挪动过就设 `OPENCLAW_BIN`。

**模型调用「3 毫秒就返回、stdout 空」**
`infer model run` 只有 `--prompt <text>`,没有 `--message-file`,所以受 Linux
`MAX_ARG_STRLEN` 限制。实测 67.2KB 正常、134.4KB 失败。签名是
`exit=null` + stdout 空 + 约 3ms 返回,**看起来像模型挂了,实为 E2BIG**。
`build-prompt.js` 硬上限 100KB 会先 fail-fast 并报出各块字节数,照它定位是哪块膨胀。

⚠️ 这个签名和**网关超时被 kill** 在 `status`/`stdout` 上完全一样,只有 `signal`/`error.code`
能区分(`E2BIG` vs `SIGTERM`+`ETIMEDOUT`)。`run.js` 按后者分流:超长不重试(重试无意义)、
超时算 infra 并重试至多 3 次。日志里报的是哪一种就照哪一种查,别把两者混为一谈。

**报告没来,也没收到失败简报**
先看退出码。`4` 说明预测已入库、只是飞书没发出去(此时不会补发简报——同一条通道
刚失败,简报会以完全相同的方式失败)。查 `~/.local/state/gold-forecast/sent.json`
与 openclaw 的 run logs。

**某天变成「降级预测」**
两个原因:① 模型 pin 校验失败(返回的 `model` 不是 M3 或发生过 failover)——
openclaw 的 fallback 链在本系统里是污染源,别的模型跑出的预测混进同一条 `final`
曲线,结论即废,故宁可当天不用 LLM;② 自检 3 轮未通过。
两者都会在 stderr 打出降级原因,且记录标 `degraded: true`、不计入模型表现统计。

**特征降级(`WARN 特征降级: ...,本次退回 p0_N`)**
依赖分三级,语义各不相同:

| 级别 | 字段 | 缺失后果 |
|---|---|---|
| `settlement_hard` | `lbma.pm_usd` | 结算与预测都做不了,`collect-settlement` 退 4 |
| `forecast_hard` | `fred.DFII10`、`eastmoney.UDI` | 当天不写任何产物、`collect-facts` 退 3;**但 Step 1a→2→2b 已完成,结算与记分卡不受影响** |
| `soft` | 其余 | 字段标 `missing`,正文禁止拿它当论据(C5);若属模型特征则整包退回 `p0_N` 并标 `degraded` |

**「结算未完成」与「结算已完成」**
失败简报会写明这一条。结算(Step 2)只依赖 LBMA、先于预测链路,所以绝大多数失败
场景下结算都已完成,统计没有缺口,**不要去手工补数**。

**权威库与恢复**

| 副本 | 位置 | 职责 |
|---|---|---|
| 权威 | `~/.local/state/gold-forecast/` | 唯一读取源 |
| 备份 | `~/backup/gold-forecast/` | **唯一恢复源**,在任何同步范围之外 |
| 人类可读 | 归档目录 `_data/` | 仅供查阅,**明确不作恢复源** |

知识库副本处在会被同步删除的区域内(2026-07-28 实证:一次 backup 提交删掉了运行主机上
两个归档件),所以它不能承担恢复职责。备份用的 rsync **不带 `--delete`**:
权威目录被误删后,一次带 delete 的同步就会把恢复源一并抹平。

## 依赖

- Node.js 18+(原生 fetch)、系统 `unzip`(解 CFTC 年度 zip)、`flock`、`rsync`
- openclaw CLI:`infer model run` 调 MiniMax-M3、`message send --channel feishu` 推送
- 零 npm 依赖,统计计算(normInv / logistic / Diebold-Mariano + Newey-West)全自写并对拍验证
