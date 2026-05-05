#!/usr/bin/env bash
# Feishu summary builder and push (design §6.2 + §9 cron alert).

build_summary() {
  local agg_file=$1
  local agg
  agg=$(cat "$agg_file")

  local date_str ovw products_count
  date_str=$(echo "$agg" | jq -r '.date')
  products_count=$(echo "$agg" | jq '.products | length')
  ovw=$(echo "$agg" | jq '.overview')

  local in_p t_done unas idle bg_total bg_new bg_res bg_cls
  in_p=$(echo "$ovw" | jq -r '.in_progress')
  t_done=$(echo "$ovw" | jq -r '.today_done')
  unas=$(echo "$ovw" | jq -r '.unassigned')
  idle=$(echo "$ovw" | jq -r '.idle')
  bg_total=$(echo "$ovw" | jq -r '.bugs_total')
  bg_new=$(echo "$ovw" | jq -r '.bugs_today_new')
  bg_res=$(echo "$ovw" | jq -r '.bugs_today_res')
  bg_cls=$(echo "$ovw" | jq -r '.bugs_today_cls')

  cat <<EOF
📊 产研日报 · ${date_str}

🎯 覆盖产品:${products_count} 个

📋 需求:进行中 ${in_p} / 今日完成 ${t_done} / 未分配 ${unas} / 未执行 ${idle}
🐛 Bug:总 ${bg_total},今日 +${bg_new} / 解决 ${bg_res} / 关闭 ${bg_cls}

🔗 详情见知识库 daily/${date_str}
EOF
}

# Push to Feishu webhook. Returns 0 on success, 1 on failure.
push_to_feishu() {
  local webhook=$1
  local content=$2
  if [ -z "$webhook" ]; then
    echo "⚠ webhook empty, skip" >&2
    return 0
  fi
  local payload
  payload=$(jq -n --arg c "$content" '{msg_type:"text", content:{text:$c}}')
  local resp
  resp=$(curl -sS --max-time 10 -X POST -H "Content-Type: application/json" -d "$payload" "$webhook" 2>&1)
  if echo "$resp" | jq -e '.code == 0' >/dev/null 2>&1; then
    return 0
  fi
  echo "❌ feishu push failed: $resp" >&2
  return 1
}

# Push summary; cron mode escalates to FEISHU_ALERT_WEBHOOK on primary failure.
push_summary() {
  local agg_file=$1
  local mode=${2:-manual}   # manual | cron

  local content
  content=$(build_summary "$agg_file")

  if push_to_feishu "${FEISHU_DAILY_WEBHOOK:-}" "$content"; then
    return 0
  fi

  if [ "$mode" = "cron" ]; then
    local alert="${FEISHU_ALERT_WEBHOOK:-${FEISHU_DAILY_WEBHOOK:-}}"
    local alert_msg="⚠️ daily-report 飞书推送失败,日报已落盘,请人工 check;原文:$content"
    if push_to_feishu "$alert" "$alert_msg"; then
      return 1   # primary failed but alert succeeded
    fi
    echo "❌ alert webhook also failed" >&2
    return 2
  fi
  return 1
}

export -f build_summary push_to_feishu push_summary
