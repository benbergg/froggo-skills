#!/bin/sh
# openclaw cron 的入口。存在的理由是把「引号嵌套 + 退出码保真 + 双写日志」固化下来 ——
# 这三件事塞进 cron 的单行 --command 里很容易写错,而错了要等到次日才发现。
# 输出同时进 stdout(openclaw 存 run 历史、后台可见)与 cron.log(可 grep 的长期日志)。
set -u

STATE="$HOME/.local/state/gold-forecast"
LOG="$STATE/cron.log"
OUT="$STATE/last-run.out"
LOCK=/tmp/gold-forecast.lock
RUN="$HOME/.openclaw/skills/gold-forecast/references/scripts/run.js"

mkdir -p "$STATE"

# 凭据只从 chmod 600 的文件读,不进 jobs.json —— 那份配置会被后台完整展示
if ! . "$HOME/.config/gold-forecast/env"; then
  echo "FATAL: 读不到 $HOME/.config/gold-forecast/env" | tee -a "$LOG"
  exit 1
fi

date >> "$LOG"
# -n 不排队:上一次还没跑完就说明另有问题,排队只会让两次撞在一起
flock -n "$LOCK" -c "node $RUN" > "$OUT" 2>&1
rc=$?

# flock 抢不到锁时退 1 且不产任何输出,与 run.js 自己的「参数错退 1」外观一致,
# 靠输出是否为空区分 —— 否则后台只看到一个光秃秃的 1
if [ "$rc" -eq 1 ] && [ ! -s "$OUT" ]; then
  echo "flock: 上一次运行尚未结束,本次跳过" > "$OUT"
fi

cat "$OUT" >> "$LOG"
echo "exit=$rc" >> "$LOG"
cat "$OUT"
echo "exit=$rc"
exit "$rc"
