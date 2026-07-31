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
| `SEND_NOTIFY` | ✓(生产) | 缺省 0 即**只演练不真发,且退 0** ⇒ 整体 exit 0、链路全绿,而报告与失败简报都不会到达任何人。生产与 cron 必须显式设 1 |
| `OPENCLAW_BIN` | – | 缺省 `~/.npm-global/bin/openclaw` |
| `GOLD_RSYNC_BIN` | – | 覆盖 rsync 路径(非标准环境用) |

凭据一律由环境提供,本 skill 的任何文件里都不写真实值。

> [!important] `~/.config/gold-forecast/env` 每行必须带 `export`
> 下文所有命令都用 `. ~/.config/gold-forecast/env;` 前缀载入凭据。`.`(source)只把
> `KEY=value` 设成**当前 shell 的变量**,不导出 —— `node` 是子进程,`process.env` 里读不到。
> 首次部署实测:回填的四条 FRED 序列全部 `✗ FRED_API_KEY 未设置`,而 `cat` 那个文件
> 明明看得见 key。写成 `export KEY=value`。

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

各子脚本自己的码表**与 run.js 的不是一套**,读失败简报时别把两者的数字混起来:

| 脚本 | 0 | 1 | 其他 |
|---|---|---|---|
| `collect-settlement.js` | 成功 | 运行期异常 | **4**=数据陈旧或无有效记录 |
| `collect-facts.js` | 成功 | 参数/运行期异常 | **3**=预测硬依赖缺失,不写任何产物(当前只有 `fred.DFII10`) |
| `backfill.js` | 全部成功 | 全失败 | **2**=部分序列失败 |
| `validate.js` | 恒 0 | — | 通过与否看 `findings.json` 的 `passed`,**不看退出码** |
| `render.js` | 成功 | 参数错 | — |
| `commit.js` | 成功 | 参数错 | **3**=入库归档已成功但备份失败;**5**=运行期异常/权威库损坏 |
| `push.js` | 已发送或去重跳过 | 参数错 | **4**=发送失败;**5**=运行期异常 |

简报里的「退出码」是**失败那一步的子进程退出码**。模型调用与 `build-prompt` 超限
这两条路没有子进程,简报会显示「未知」并把具体原因写进步骤名(如
`build-prompt · 参数超长(超出 build-prompt 的 100KB 预算…)`)——
这里刻意不编一个数字,否则会与上表的含义撞车。

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

# 3b. 【强制核对,不通过不得进入第 4 步】抽查 FRED 落盘形态。
#     写成会 exit 1 的形式:只打印的版本夹在一串可粘贴命令中间,从上往下连着贴会直接冲过去
#     (本项目的教义是物理断路 > 提示)。两条判据的含义见下方小节。
ssh <host> 'H=~/.local/state/gold-forecast/history/fred_DFII10.jsonl;
  grep -q "\"value\":null" $H && { echo "3b FAIL: 有 value:null"; exit 1; };
  n=$(awk -F"\"available_date\":\"" "{print substr(\$2,1,10)}" $H | sort -u | wc -l | tr -d " ");
  [ "$n" -gt 1 ] || { echo "3b FAIL: available_date 只有一个取值"; exit 1; };
  echo "3b OK: available_date 取值数=$n"; head -1 $H'

# 4. 基线参数标定(walk-forward 回测)
ssh <host> 'node ~/.openclaw/skills/gold-forecast/references/scripts/backtest.js \
  --history ~/.local/state/gold-forecast/history --from 2019-01-01 --to $(date -d yesterday +%F) \
  --out ~/.local/state/gold-forecast/params.json'

# 5. 首次演练,确认各步产物齐备后再去掉 --dry-run
ssh <host> '. ~/.config/gold-forecast/env; node ~/.openclaw/skills/gold-forecast/references/scripts/run.js --dry-run'
```

> [!warning] 第 3 步会把东财打到限流,重跑要留冷却
> 回填对 5 个东财序列各拉 5000 条 K 线。首次部署实测:前 2 条成功,后 3 条起
> `fetch failed`;补跑时 `518880` 连挂 6 次才成。签名是 **ICMP 0% 丢包 84ms,
> 而 HTTPS 在 0.5s 内被拒**(`http=000`,不是超时),同机访问其他站点正常
> —— 应用层按 IP 拒连,不是网络故障。
> 补跑用 `--only`(支持逗号分隔),**每次之间隔几秒**;连续失败就停手等十几分钟,
> 继续重试只会把冷却时间拉长。日常 `collect-facts` 每序列只拉 60 条、总共 5 个请求,
> 负载与回填不是一个量级。
>
> 量化过程:部署开始时前 2 个请求还成功,量到 1.5 小时后间隔 5s 跑 20 次只成 1 次。
> **不是封禁** —— 同一时刻 curl 与 node 一起失败、ICMP 0% 丢包 84ms、
> 本机 Mac 打同一 URL 200/0.36s、而 VM 自己解析的边缘节点仍会偶尔回 200。
> 是按 IP 的累积限流,恢复窗口 > 1.5 小时。故五个东财字段**全部是 soft**,
> 全挂也只让 facts 变薄、不阻塞当日预测。

### 第 3b 步的判据(两条都必须成立)

1. 第一行的 `value` 是**有限数**,不是 `null`
2. `available_date` 有**多个不同取值**,且不是全部等于 `--until`

命令本身会在任一条不成立时 `exit 1`(只打印的版本夹在可粘贴命令块中间会被连着贴过去)。
判据不成立就**停在这里**,别跑第 4 步。两条都不成立的典型签名是 FRED 返回了宽表
(`output_type=2/3`:列名 `SERIESID_YYYYMMDD`、没有 `value` 键)。这个故障曾经
全程 `exit 0`:回填打 `✓ inserted=N`、`回填完成: 成功 5, 失败 0`,而整库落成
`value:null`;生产端 `null - null === 0` 被「特征降级」判为健康,回测端因
`available_date` 全等于 `--until` 而 FRED 行全程不可见 ⇒ `evaluated=0` ⇒
logistic 永远拿不到系数。现在形态不符会让该序列进 `failed` 并退 2,但**响亮失败
只能保证「不装作成功」,不能保证「形态是对的」** —— 这一步是唯一的正向确认。

另外:`baseline.js` 现在会对任何退回 `p0_N` 的周期打一行
`WARN 未跑 logistic 的周期: …`。日常若持续看到它,先查 `params.json` 是否存在、
`coefficients` 是否为空,再查特征降级。

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

另需在回测产出后标定 `validate.js` 的 `C3_K_LO` / `C3_K_HI`(当前 0.5 / 2.0 是占位值,
区间偏宽,只是约束松、不会误拦),做法是枚举宽度倍数看哪个区间能同时容纳历史通过项。

回测三期各自记录 `n` / `brier_gain` / `dm_p` / `passed`。**未通过的周期退化为 `p0_N`
是预期结果之一,不是失败**——那正是「基线只在证明得了自己的地方才上模型」的设计意图。

### cron

**默认不启用。** 先手动观察若干天的产出,确认无误后再由用户决定是否建定时任务。
建的时候按上面那条 `flock` 写法包住 `run.js`,并把下面**四个**环境变量全部显式导出
—— **cron 的环境不是登录 shell 的环境**:

```cron
0 8 * * *  FRED_API_KEY=... GOLD_FEISHU_TARGET=... GOLD_ARCHIVE_DIR=... SEND_NOTIFY=1 \
           flock -n /tmp/gold-forecast.lock -c 'node ~/.openclaw/skills/gold-forecast/references/scripts/run.js' \
           >> ~/.local/state/gold-forecast/cron.log 2>&1
```

> [!important] `SEND_NOTIFY=1` 不能漏
> `push.js` 未设它时走 `--dry-run` 并**退 0**,于是 `run.js` 判 `success`、整体
> `exit 0`——**链路全绿,而报告与失败简报都永不到达任何人**。这是本系统唯一一处
> 「全部正常」和「通知层完全关闭」长得一模一样的地方。
> `run.js` 在非 dry-run 且未设它时会打一条显著 WARN,但 cron 的 stderr 要有人看才算数,
> 所以上面把日志重定向到了文件。

值放在 crontab 里会被同机其他用户 `ps`/`/proc` 看到。生产上建议改成
`. ~/.config/gold-forecast/env;` 前缀,把四个变量都写进那个 chmod 600 的文件。

> [!note] 失败之后的周末会重跑,每次真付一次模型调用
> 失败当天不入库 ⇒ `max(base_date)` 不推进 ⇒ 次日(哪怕是周六)仍判「有新定盘」
> 而跑完整条流水线,直到某天成功为止。这是有意的自愈行为(故障修好后无需人工补跑),
> 代价是每次重跑都真调一次 M3。连挂多天时留意这笔开销,必要时先停掉 cron 再排查。

### 教训库

`lessons.json` 由 `commit.js` 在入库事务里写,与 `predictions.json` 同成同败。

- `trials` / `hits` **不在这个文件里** —— 它们是 scorecard 对 predictions 的投影,
  看 `scorecard.json` 的 `lessons` 段。改 `lessons.json` 里的 trials 不会有任何效果。
- 每日最多进 2 条,active 满 20 条后拒收新教训并打 WARN(commit 退 0,
  由 `run.js` 转述进 run 日志)。看到
  `active 已达上限` 时先查是不是退休没生效(冷门 tag 下的教训攒不够 5 次 trials
  会永久占位),而不是直接调大上限。
- status 单向流转,不复活。误判退休的教训要重新提出为新 id。

## Step 4 写作规范摘要

完整契约在 `references/scripts/build-prompt.js` 的 `CONTRACT` 常量里,**判定在
`validate.js` 的 C1–C14**。此处只列要点,细则不在本文档复述以免两处走样:

- 输出 = 开头一个围栏 JSON 块(承载全部可判定字段)+ 其后七段中文正文,标题用「一、」至「七、」
- `prob_up` 一律是上涨概率,`direction` 由它派生(>0.5 为 up),二者必须一致
- 正文每个数字都要能在事实包 / 基线 / 统计校准里查到,或由白名单运算得出(容差 0.5%)
- 标 `missing` 的字段,正文不得出现相关论据
- 胜率 / Brier / Winkler 必须直接引用统计校准的数值,不得自算
- 新闻必须带链接,链接须来自新闻线索块
- **不给仓位、杠杆、买卖点位、止损价**——产品红线。机器执行者是 C12,两条判据都按**子句**判:
  第六段按「红线概念与**具体数量**(阿拉伯数字 ∪ 中文数量)同子句」——该段合法地要讲
  「怎么自行推算止损距离」,拦的是数量而不是词;一–六段另按**指令性构造**判 ——
  指令性标记(或「某价位以下买入」这类价位构造)与红线概念落在同一子句才算越界,
  描述第三方持仓/流向(央行购金吨数、ETF 流向、COT 多空)与免责/反事实语境不触发。
  数字一律先做全角归一化:`５１７３７` 曾同时穿过 C12 与整个 C4 溯源层。
  提示词契约比自检**更严**(要求第六段一个数字都不写),这个方向是安全的:自检更松只会少拦,
  不会因为契约做不到而每天烧修复轮
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
**先确认 `SEND_NOTIFY=1` 已设**——这是最常见也最难看出来的一种:未设时 `push.js`
走 `--dry-run` 退 0,整条流水线 `exit 0`、日志全绿,而两种消息都不会发出。
`run.js` 会打 `WARN: SEND_NOTIFY 未设为 1`,在 cron 日志里搜这一行。

排除它之后再看退出码:`4` 说明预测已入库、只是飞书没发出去(此时不会补发简报——
同一条通道刚失败,简报会以完全相同的方式失败);`0` 且无 WARN 则查
`~/.local/state/gold-forecast/sent.json`(内容相同的消息会被去重跳过)与 openclaw 的 run logs。

**很多天没有任何输出,退出码一直是 0**
看 `run-state.json` 的 `consecutive_non_trading`。LBMA 源冻结(持续返回 HTTP 200 +
旧 JSON)时每天都判「无新定盘」,本就不推送——连续 6 次会自动发一条 `stale-lbma`
告警兜底,但那条同样受 `SEND_NOTIFY` 约束。手工核对:
`jq .latest ~/.local/state/gold-forecast/settlement-price.json` 的日期是否还在动。

**`FATAL: predictions.json 不存在,但本机跑过`**
权威库丢了。**不要**手工建一个空库了事——那会让 settle 在空库上跑、scorecard 全部
`insufficient_sample`、commit 只入一条,随后 rsync 把备份也覆盖成单条版本。
从 `~/backup/gold-forecast/` 恢复,或从 `~/.local/state/gold-forecast/versions/`
捞回上一版(原子写留的滚动副本)。确属首次部署才手工创建空库。

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

## 已知局限

合并前评审裁定「留但必须成文」的项。都不是 bug 报告的替代品——列在这里是为了让
下一个人不必再发现一次。

1. **C4 的盎司/克容差把允许池放宽了。** 白名单运算含 `÷31.1035`,于是任一池内数字
   乘/除 31.1035 后的值也算「有出处」。评审实测的误接受率量级 7.4% / 11.1% / 8.2% / 2.9%
   (四组夹具)。**正确修法是按 `facts.schema.json` 的 `unit` 字段收窄**(只允许
   单位确为盎司/克的字段参与换算),属独立 task;**不是删掉 ×31.1035** ——
   `eastmoney.aum` 的单位本身就是 CNY/g,删了会把合法引用拦下。
2. **截断态下 C4 的池宽于 prompt。** 池由**完整**对象算出,而 prompt 里的可截断块
   可能被压缩过,于是模型看不到的数字仍在池里(单向放宽,不会误拦)。
   `brier_series` 从 payload 剥出后 `calibration` 恒定约 3KB、唯一大块只剩 `facts`,
   这条的暴露面已大幅下降。
3. **C-1 残留:C2 的 `expected` 里可能回显模型上轮自己写的值。** `prior_findings`
   块只含 `expected`(自检器自算的修正目标)因而可引用,但 C2 的 expected 形如
   `prob_up=0.58 时须为 up`,那个 `0.58` 来自模型上轮的输出而非事实源。裁定为留:
   它来自 JSON 块、已由 C1/C2/C3/C14 逐值管辖,当轮 `doc.json` 同名值本就在池里,
   回显不引入新能力。
4. ~~（已实现，见 [[20260731-黄金教训库写入端-v1-设计文档]]）~~
5. **`C3_K_LO` / `C3_K_HI` 仍是占位值**(0.5 / 2.0),待回测枚举宽度倍数后标定。
6. **`validateParams` 不校验 `params.features` 与系数长度。** `backtest.buildParams`
   专门把 `features: MODEL_FEATURES` 写进 `params.json` —— 那就是 train/serve 契约本身 ——
   而 `validateParams` 只看 `sample_period`。实测(改 params.json 而不动代码):
   特征顺序颠倒 + 4 系数 ⇒ `rejected=null`、`model=logistic`、`prob_up=0.9085`,
   **静默服务错模型**;系数只给 2 个 ⇒ `prob_up: NaN` 序列化成 `null`,且因为
   `model` 仍是 `logistic`,**绕过 MF-4 那条「未跑 logistic 的周期」WARN** ——
   下游只会以 C9 误触发、报告里「上涨概率 null」这类症状出现,指不到根因。
   当前生产者(`buildParams`)恒发 4 个系数且顺序取自同一个 `MODEL_FEATURES`,
   所以**今天不可达**,是「改了 `MODEL_FEATURES` 而生产上留着旧 params.json」的漂移风险。
   修法与既有拒绝路径同构(约 3 行):`features` 须 `deepEqual(MODEL_FEATURES)`、
   `coefficients[k].length === MODEL_FEATURES.length + 1`,否则 `reject(...)`。延后。
7. **MF-1 的第二个症状(`available_date` 全塌成 `--until`)没有代码级判据。**
   `parseObservations` 只对「值解析不出有限数」响亮失败;而「值全有限、但每行
   `available_date` 都等于 `--until`」这一形态照常入库,签名是回测期间 FRED 行
   全程不可见 ⇒ `evaluated=0` ⇒ logistic 永远拿不到系数。部署第 3b 步现在会为此
   `exit 1`,但那是一次性的部署闸门,**日常重跑/续跑不覆盖**。可加(约 3 行):
   `mode === 'vintages'` 且解析出的 `available_date` 去重后只有一个取值 ⇒ 抛错
   (非 vintages 模式不适用 —— 日频不带 realtime 区间时 `realtime_start` 本就等于今天)。
   不阻塞的理由:MF-4 的 WARN 修好后这个状态每天都会喊,加上回测 `n=0` 与
   `samples_short_by`,它已不是静默故障,只是没在正确的层被诊断。
8. **正文红线的残留漏拦面远大于「1/41」,而这层防线的收益在误拦侧、不在召回侧。**
   同一批语料跑三个版本(真旧代码取自 `git archive`,不是复刻):

   | 语料 | `74793c4` | `d4dbf4e` | 当前 |
   |---|---|---|---|
   | 中立语料 29 条越界 | 漏拦 **24** | 漏拦 **25** | 漏拦 **23** |
   | 中立语料 8 条合法 | 误拦 1 | 误拦 0 | 误拦 0 |
   | 中立语料 9 条第六段合法方法说明 | 误拦 0 | 误拦 **7** | 误拦 **0** |
   | 自写语料 39 条合法 | 误拦 7 | 误拦 0 | 误拦 0 |
   | 自写语料 41 条越界 | 漏拦 28 | 漏拦 1 | 漏拦 1 |

   即**红线规则对中文祈使句的召回本来就低**(中立语料 4/29 ≈ 14%),改判指令性构造换来的是
   误拦侧(免责句自己被拦 ⇒ 每天降级发布)。「漏拦 1/41」出自实现者自写语料 + 自定判据,
   那 41 条越界句几乎都带 `建议/应当/请`,而中文祈使句大多不带 —— **不要拿它当这层防线的
   可信度依据**。

   **5 个结构上互不相同的漏拦族 + B 类词单独出现**,每族附放它过去的那道闸
   (例句注入第四段,当前全部零 findings):

   | 族 | 例句 | 放它过去的闸 |
   |---|---|---|
   | 长复合词挖空 | 建议把杠杆水平提高到接近上限。 | `maskCompounds` 把 `杠杆水平` 整词挖空 ⇒ 红线概念消失 |
   | 描述性主语(句级) | 多头趋势未变，半仓参与即可。 | 前一子句的 `多头` 让后一子句整句豁免 |
   | 否定标记 | 不建议轻仓而应当重仓持有。 | 否定检查排在指令检查**之前**,无条件 `continue` |
   | 反事实 | 若价格跌破下沿就止损离场。 | `COUNTERFACTUAL_RE`;条件式指令是交易建议最标准的写法 |
   | 报告自述 | 本报告建议无经验者重仓买入。 | `SELF_NEGATION_RE` 只要句里有 `不/未/无` 就整句豁免 |
   | B 类词单独出现 | 逢低买入，逢高卖出。 | 无指令标记 + 无价位构造 ⇒ 恒豁免 |

   族计数(中立语料 23 条漏拦):挖空 5 / 描述性主语 7 / 否定 4 / 反事实 2 / 自述 2 / B 类单独 3。
   反事实那族已由「显式指令标记压过反事实豁免」收掉 2 条(`如果你想参与就在3978买入` /
   `假设行情走弱则应当清仓`),**剩下的 2 条不带任何指令标记**(`若价格跌破下沿就止损离场` /
   `倘若突破上沿就加仓至满仓`)—— 那正是与「若当时按下沿止损将被扫」这类反面警示句
   表层特征相同、只差语义的一对,不能再靠标记分开。
   否定标记那族**刻意不动**:`不建议/禁止/不得` 同时是免责句的主力词,把标记提到否定层
   之上实测会让免责句自己被拦(误拦 2 条、T35/T40/T42 同时红)。
   ⇒ **对无主语祈使句的实际召回是 0。** 把价位构造提到描述性主语之上会立刻打掉
   「各国央行在4000美元附近继续增持」这类设计 8.1 要求第二段必写的内容 —— 它与
   「机构测算显示，4059以上卖出更优」的表层特征几乎相同,差别是纯语义的。故这一层要真正修好
   需要语义理解,不打算继续用词表补(收窄/扩张清单已被证伪:见下一条与本条末)。

   另有四条口径要一起记住:
   - 「指令与宾语被中文逗号拆到同一句的两个子句、且不含价位构造」仍漏(例:
     「建议分批操作，买入价位自行决定。」)。判定按子句做是**必须的** —— 句级判定会把
     「建议读者结合自身情况判断，多头仓位数据于下周公布」这类正常句子误拦。
   - 第六段的判据是「红线概念与具体数量同子句」,所以该段不带数量地讲 `止损/仓位/杠杆`
     是合法的(设计 8.1 要求它讲「怎么自行推算止损距离」);反过来
     「区间半宽约为45点」这类只有数量、没有红线概念的说明红线不拦(溯源仍由 C4 管,
     该句实测触发 C4)。
   - 第六段同样先挖空长复合词,代价是 `请将杠杆率提高一档` 在第六段也漏。这是量过的取舍:
     不挖空会让 3 条合法描述性表述被误拦、只多拦这 1 条(T45 钉住)。
   - **曾走错的一条路**:第六段一度实现成「整段禁具体数量」,量词表含 `点/档/块/元/成` ⇒
     「有一点需要说明」「有三点注意事项」「并非一成不变」「分为两块」「一元化」全部命中,
     中立语料误拦 7/9。收窄量词清单治不了它:`三成` 是仓位的规范写法,`成` 删不掉却又栽在
     `一成不变`。**清单换个存储位置仍然是清单**,判据必须落在语义维度。

9. **中文数字在一–五段完全穿透 C4(溯源)与 C14(与 JSON 一致)。** 实测第四段注入
   「金价较上一交易日上涨三十七美元」「本期区间下沿为三千九百七十八」全部零 findings ——
   这两层是防「编造数字」与「正文 JSON 打架」的全部机器防线,在中文数字写法下召回为 0。
   **判为已知局限而非必修**,两条理由:①契约里已经没有任何指向中文数字的指令(旧契约那句
   「需要计数时用中文数字」已删),模型没有理由用中文数字写价格;②把中文数字并进
   `extractNumbers` 的误报代价更高 —— 池里够不到 `二季度`/`第三方`/`一致` 这类词里的中文字,
   C4 会大面积误报,而误拦的代价是每天降级发布。已知局限 8 末尾那条「整段禁数量」的教训
   正是同一判据用在第六段时的反面教材。
10. **`momentum_z` 两端只钉了「值相等」,没钉「缺失判据相等」。** 回测 T20 断言的是
   「同一天、三特征都可用时,训练端 `dailyView` 与服务端 `computeBaseline` 逐值相等」。
   把训练端 `cotPctile` 的 `minSamples` 从 20 改成 5,**值不变而全套 486 项全绿**(本轮独立复现过),但进入训练集
   的日子变了 —— 服务端判 null → 退回 `p0_N`,训练端却拿它训练过。这正是这条特征的前身
   (`real_yield_chg`)踩过的那类偏斜:缺失处理不一致,不报错、回测漂亮、实盘失效。
   当前两端都用默认值,所以今天不可达;要钉住得断言两端的**入选判据**相等,不只是值相等。

## 依赖

- Node.js 18+(原生 fetch)、系统 `unzip`(解 CFTC 年度 zip)、`flock`、`rsync`
- openclaw CLI:`infer model run` 调 MiniMax-M3、`message send --channel feishu` 推送
- 零 npm 依赖,统计计算(normInv / logistic / Diebold-Mariano + Newey-West)全自写并对拍验证
