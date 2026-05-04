# Auth & Curl Snippets — Zentao API v1

> 把下面 6 段 bash 全部复制到当前 shell 后 `eval`,即获得本 skill 全部调用能力。
> 6 段也可单段使用,按需复制。

## 前置依赖

- bash >= 4
- curl
- jq
- macOS(BSD `date`)或 Linux(GNU `date`),snippet S6 已做兼容

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `ZENTAO_BASE_URL` | ✓ | 例 `https://chandao.bytenew.com/zentao/api.php/v1` |
| `ZENTAO_ACCOUNT`  | ✓ | 登录账号 |
| `ZENTAO_PASSWORD` | ✓ | 密码 |
| `ZENTAO_ME`       | – | 缺省取 `/user.profile.account` |
| `ZENTAO_CACHE_DIR`| – | 缺省 `${XDG_CACHE_HOME:-~/.cache}/zentao` |

## S1: zt_init — 校验环境 + 缓存目录

```bash
zt_init() {
  setopt local_options typeset_silent 2>/dev/null   # zsh 默认 UNSET,导致 `local var; var=$(cmd)` 回显 var=value 到 stdout 污染输出
  local missing=()
  [ -z "${ZENTAO_BASE_URL:-}" ] && missing+=("ZENTAO_BASE_URL")
  [ -z "${ZENTAO_ACCOUNT:-}"  ] && missing+=("ZENTAO_ACCOUNT")
  [ -z "${ZENTAO_PASSWORD:-}" ] && missing+=("ZENTAO_PASSWORD")
  if (( ${#missing[@]} > 0 )); then
    printf 'FATAL: missing required env: %s\n' "${missing[*]}" >&2
    return 2
  fi
  ZT_CACHE="${ZENTAO_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/zentao}"
  mkdir -p "$ZT_CACHE" && chmod 700 "$ZT_CACHE" 2>/dev/null || true
  export ZT_CACHE
}
```

## S2: zt_acquire_token — POST /tokens

```bash
zt_acquire_token() {
  setopt local_options typeset_silent 2>/dev/null
  zt_init || return $?
  local body resp token
  body=$(jq -cn --arg a "$ZENTAO_ACCOUNT" --arg p "$ZENTAO_PASSWORD" \
    '{account:$a,password:$p}')
  resp=$(curl -s --noproxy '*' --max-time 20 -X POST "$ZENTAO_BASE_URL/tokens" \
    -H 'Content-Type: application/json' -d "$body") || true
  token=$(printf '%s' "$resp" | jq -r '.token // empty' 2>/dev/null)
  if [ -z "$token" ]; then
    printf 'FATAL: token acquire failed: %s\n' "$resp" >&2
    return 1
  fi
  local f="$ZT_CACHE/token.json"
  jq -cn --arg t "$token" --arg ts "$(TZ=UTC date '+%Y-%m-%dT%H:%M:%SZ')" \
    '{token:$t,acquired_at:$ts}' > "$f"
  chmod 600 "$f"
  printf '%s\n' "$token"
}
```

## S3: zt_get — GET 包装(sanitize + 401 重取)

Sanitize 步骤 `LC_ALL=C tr -d '\000-\037'` 关键:
1. 多个端点(实测 `/programs`、部分 `/executions/{id}/tasks`)在字符串字段值里嵌**未转义**的 `\x01-\x1f`(JSON 规范要求 string 内 0-31 必须 escape),jq 严格 parse 会整体失败
2. NUL 字节会让 bash `$(...)` 截断,响应被静默截短
3. **strip 全部 C0(0-31)而非保留 `\t\n\r`** — 早期版本曾试图保留这三个作为合法 JSON inter-token 空白,但实测 Zentao 把它们当 in-string 内容嵌入,保留即破解析。代价:多行 description 字段内部 `\n` 会被吃掉(只读 API 消费场景可接受)。详见 `known-issues.md` §11

```bash
zt_get() {
  setopt local_options typeset_silent 2>/dev/null
  zt_init || return $?
  local ep="$1"
  local f="$ZT_CACHE/token.json"
  local token=""
  [ -f "$f" ] && token=$(jq -r '.token // empty' "$f" 2>/dev/null)
  [ -z "$token" ] && token=$(zt_acquire_token) || true
  [ -z "$token" ] && return 1

  local url="${ZENTAO_BASE_URL}${ep}"
  local resp
  resp=$(curl -s --noproxy '*' --max-time 20 -X GET "$url" \
    -H "Token: $token" -H "Content-Type: application/json" \
    | LC_ALL=C tr -d '\000-\037') || true

  if printf '%s' "$resp" | grep -qi '"error":"[Uu]nauthorized"'; then
    token=$(zt_acquire_token) || return 1
    resp=$(curl -s --noproxy '*' --max-time 20 -X GET "$url" \
      -H "Token: $token" -H "Content-Type: application/json" \
      | LC_ALL=C tr -d '\000-\037') || true
  fi
  printf '%s\n' "$resp"
}
```

## S4: zt_write — POST/PUT 包装

用法:

- `zt_write POST /executions/3292/tasks '{"name":"x","estStarted":"2026-05-04","deadline":"2026-05-06"}'`
- `zt_write PUT  /tasks/43906          '{"parent":43901}'`

```bash
zt_write() {
  setopt local_options typeset_silent 2>/dev/null
  zt_init || return $?
  local method="$1" ep="$2" body="$3"
  case "$method" in POST|PUT) ;; *)
    printf 'FATAL: unsupported method: %s\n' "$method" >&2; return 2 ;;
  esac
  local f="$ZT_CACHE/token.json"
  local token=""
  [ -f "$f" ] && token=$(jq -r '.token // empty' "$f" 2>/dev/null)
  [ -z "$token" ] && token=$(zt_acquire_token) || true
  [ -z "$token" ] && return 1

  local url="${ZENTAO_BASE_URL}${ep}"
  local resp
  resp=$(curl -s --noproxy '*' --max-time 20 -X "$method" "$url" \
    -H "Token: $token" -H "Content-Type: application/json" \
    -d "$body" | LC_ALL=C tr -d '\000-\037') || true

  if printf '%s' "$resp" | grep -qi '"error":"[Uu]nauthorized"'; then
    token=$(zt_acquire_token) || return 1
    resp=$(curl -s --noproxy '*' --max-time 20 -X "$method" "$url" \
      -H "Token: $token" -H "Content-Type: application/json" \
      -d "$body" | LC_ALL=C tr -d '\000-\037') || true
  fi
  printf '%s\n' "$resp"
}
```

## S5: zt_paginate — ?limit=500&page=N 循环 + 20 页安全阀

安全阀理由:顶层 `/tasks` 等"残废"端点 `limit/page` 失效永远返 1 条,不设安全阀会死循环。

```bash
zt_paginate() {
  setopt local_options typeset_silent 2>/dev/null
  local ep="$1"
  local p=1 limit=500
  while :; do
    local sep='?'
    [[ "$ep" == *'?'* ]] && sep='&'
    local resp
    resp=$(zt_get "${ep}${sep}limit=${limit}&page=${p}") || return $?
    printf '%s\n' "$resp"
    local total
    total=$(printf '%s' "$resp" | jq -r '.total // 0' 2>/dev/null)
    [ -z "$total" ] && total=0
    if [ "$(( p * limit ))" -ge "$total" ]; then
      break
    fi
    p=$(( p + 1 ))
    if [ "$p" -gt 20 ]; then
      printf 'WARN: zt_paginate hit 20-page safety valve at %s\n' "$ep" >&2
      break
    fi
  done
}
```

## S6: zt_week_range — 周一 00:00 ~ 下周一 00:00 UTC(BSD/GNU 兼容)

已知边界陷阱:
1. macOS BSD `date -j -f` 与 Linux GNU `date -d` 语法不同
2. 周日 23:59 UTC 必须归属"本周"不是"下周"
3. 跨年(2025-12-29~2026-01-04)、闰年 2 月需正确处理

```bash
_zt_iso2ep() { TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null \
              || TZ=UTC date -d "$1" +%s; }
_zt_ep2iso() { TZ=UTC date -r "$1" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
              || TZ=UTC date -d "@$1" "+%Y-%m-%dT%H:%M:%SZ"; }
_zt_ep2dow() { TZ=UTC date -j -f "%s" "$1" +%u 2>/dev/null \
              || TZ=UTC date -d "@$1" +%u; }

zt_week_range() {
  setopt local_options typeset_silent 2>/dev/null
  local now_iso="${NOW_OVERRIDE:-$(TZ=UTC date "+%Y-%m-%dT%H:%M:%SZ")}"
  local now_ep dow day_ep mon_ep
  now_ep=$(_zt_iso2ep "$now_iso")
  dow=$(_zt_ep2dow "$now_ep")
  day_ep=$(( now_ep - now_ep % 86400 ))
  mon_ep=$(( day_ep - (dow - 1) * 86400 ))

  WK_START=$(_zt_ep2iso "$mon_ep")
  WK_END=$(_zt_ep2iso $((mon_ep + 7*86400)))
  NEXT_S="$WK_END"
  NEXT_E=$(_zt_ep2iso $((mon_ep + 14*86400)))
  export WK_START WK_END NEXT_S NEXT_E
}
```

## 自检

复制全部 S1-S6 snippet 到当前 shell 后:

```bash
zt_init && echo "✓ env OK"
zt_acquire_token >/dev/null && echo "✓ token OK"
zt_get /user | jq -e .profile.account >/dev/null && echo "✓ /user OK"
zt_week_range && echo "WK_START=$WK_START WK_END=$WK_END"
```
