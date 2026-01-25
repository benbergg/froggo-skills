#!/usr/bin/env bash
# knowledge-lib-hook.sh - 知识库智能检测 Hook
# 触发：PreToolUse Hook, matcher: ^(Write|Edit)$

set -euo pipefail

# 配置
KNOWLEDGE_LIB="${KNOWLEDGE_LIB:-$HOME/workspace/Knowledge-Library}"
KEYWORDS="design|plan|requirement|task|tech|weekly|kpr"

# 从 stdin 读取 JSON（PreToolUse 事件必须通过 stdin 传递 tool_input）
input_json=$(cat)

# 检查 jq 是否可用
if ! command -v jq &> /dev/null; then
    exit 0  # 无 jq 则静默退出
fi

# 提取字段
file_path=$(echo "$input_json" | jq -r '.tool_input.file_path // empty')

# 前置检查
[[ -z "$file_path" ]] && exit 0
[[ "$file_path" == *"Knowledge-Library"* ]] && exit 0
[[ "$file_path" != *.md ]] && exit 0

# 文件名匹配
filename=$(basename "$file_path" | tr '[:upper:]' '[:lower:]')
matched_type=""

if [[ "$filename" =~ ($KEYWORDS) ]]; then
    matched_type="${BASH_REMATCH[1]}"
fi

# 无匹配则退出
[[ -z "$matched_type" ]] && exit 0

# 路径映射
case "$matched_type" in
    design)      target_dir="04-Designs/" ;;
    plan)        target_dir="03-Plans/" ;;
    requirement) target_dir="01-Requirements/" ;;
    task)        target_dir="02-Tasks/" ;;
    tech)        target_dir="07-Tech/" ;;
    weekly)      target_dir="05-Reports/weekly/" ;;
    kpr)         target_dir="05-Reports/KPR/" ;;
    *)           target_dir="" ;;
esac

# JSON 转义函数（参考 superpowers）
escape_for_json() {
    local input="$1"
    local output=""
    local i char
    for (( i=0; i<${#input}; i++ )); do
        char="${input:$i:1}"
        case "$char" in
            $'\\') output+='\\' ;;
            '"') output+='\"' ;;
            $'\n') output+='\n' ;;
            $'\r') output+='\r' ;;
            $'\t') output+='\t' ;;
            *) output+="$char" ;;
        esac
    done
    printf '%s' "$output"
}

# 构建消息
message="检测到知识文档 (${matched_type})，建议使用 doc-writer skill 保存到知识库：
目标路径: ${KNOWLEDGE_LIB}/${target_dir}
当前路径: ${file_path}

提示：请先调用 obsidian:obsidian-markdown skill 获取完整的 Obsidian Markdown 语法规范"

escaped_message=$(escape_for_json "$message")

# 输出 JSON
cat <<EOF
{"systemMessage": "${escaped_message}"}
EOF

exit 0
