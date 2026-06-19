#!/usr/bin/env bash
# 抓取报告封面所需 logo 到指定目录。
# 用法：fetch-logos.sh <输出目录> <客户品牌英文名(用于Wikimedia查找,可选)>
# 例：  fetch-logos.sh ./report/assets Lancome
set -uo pipefail

OUT="${1:?用法: fetch-logos.sh <输出目录> [客户品牌英文名]}"
BRAND_EN="${2:-}"
mkdir -p "$OUT"

# 1) 班牛橙色 logo（直达 URL，固定）
BANNIU_URL="https://starlink-pre.bytenew.com/static/logo.png"
if curl -sL -o "$OUT/banniu_logo.png" "$BANNIU_URL" --max-time 20 && \
   file "$OUT/banniu_logo.png" | grep -qi 'image'; then
  echo "OK 班牛 logo -> $OUT/banniu_logo.png"
else
  echo "WARN 班牛 logo 下载失败，封面改用文字字标"
fi

# 2) 客户 logo（优先 Wikimedia Commons，沙箱内 Clearbit 常被拦）
if [ -n "$BRAND_EN" ]; then
  TITLE=$(curl -sL --max-time 20 \
    "https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${BRAND_EN}%20logo&srnamespace=6&format=json&srlimit=8" \
    | python3 -c "
import sys, json
r = json.load(sys.stdin)['query']['search']
# 只接受图片类型，优先 svg>png>jpg，PDF 等一律排除
imgs = [x['title'] for x in r if x['title'].lower().rsplit('.',1)[-1] in ('svg','png','jpg','jpeg','gif')]
def rank(t): return ('svg','png','jpg','jpeg','gif').index(t.lower().rsplit('.',1)[-1])
print(sorted(imgs, key=rank)[0] if imgs else '')" 2>/dev/null)
  if [ -n "$TITLE" ]; then
    URL=$(curl -sL --max-time 20 \
      "https://commons.wikimedia.org/w/api.php?action=query&titles=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$TITLE")&prop=imageinfo&iiprop=url&format=json" \
      | python3 -c "import sys,json;p=json.load(sys.stdin)['query']['pages'];print(list(p.values())[0]['imageinfo'][0]['url'])" 2>/dev/null)
    EXT="${URL##*.}"
    if [ -n "$URL" ] && curl -sL -o "$OUT/client_logo.$EXT" "$URL" --max-time 20; then
      echo "OK 客户 logo -> $OUT/client_logo.$EXT"
    else
      echo "WARN 客户 logo 下载失败，封面改用文字字标"
    fi
  else
    echo "WARN 未在 Wikimedia 找到 ${BRAND_EN} logo，封面改用文字字标"
  fi
else
  echo "INFO 未提供客户品牌英文名，跳过客户 logo（封面用文字字标）"
fi
