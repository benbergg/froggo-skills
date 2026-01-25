#!/bin/bash
# knowledge-lib-hook.sh
# 知识库智能检测 Hook
#
# 功能：在 Write/Edit 操作时检测知识文档，建议使用 doc-writer 保存到知识库
# 触发：PreToolUse Hook, matcher: ^(Write|Edit)$

set -e

# ============================================================
# 配置
# ============================================================
KNOWLEDGE_LIB="${KNOWLEDGE_LIB:-$HOME/workspace/Knowledge-Library}"
KEYWORDS="design|plan|requirement|task|tech|weekly|kpr"

# ============================================================
# 从 stdin 读取 JSON 输入（Claude Code 通过 stdin 传递参数）
# ============================================================
input_json=$(cat)

# 使用 Python 解析 JSON（可靠处理特殊字符）
read_json_field() {
    local field="$1"
    echo "$input_json" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    val = d.get('tool_input', {}).get('$field', '')
    print(val if val else '')
except:
    print('')
" 2>/dev/null || echo ""
}

file_path=$(read_json_field "file_path")
content=$(read_json_field "content")

# ============================================================
# 前置检查
# ============================================================

# 空路径直接退出
[[ -z "$file_path" ]] && exit 0

# 已经是知识库路径，不重复提示
[[ "$file_path" == *"Knowledge-Library"* ]] && exit 0

# 非 .md 文件，不处理
[[ "$file_path" != *.md ]] && exit 0

# ============================================================
# 文件名检测
# ============================================================
filename=$(basename "$file_path" | tr '[:upper:]' '[:lower:]')
matched_type=""

if [[ "$filename" =~ ($KEYWORDS) ]]; then
    matched_type="${BASH_REMATCH[1]}"
fi

# ============================================================
# 路径检测
# ============================================================
path_matched=false

# 检测是否写入 docs/ 或项目根目录的 .md 文件
# 匹配: docs/xxx.md, doc/xxx.md, ./xxx.md, xxx.md (无子目录)
if [[ "$file_path" =~ ^\.?/?(docs?/|[^/]+\.md$) ]]; then
    path_matched=true
fi

# ============================================================
# 内容检测 (frontmatter)
# ============================================================
content_matched=false

if [[ -n "$content" ]]; then
    # 检测是否以 --- 开头（frontmatter）
    if [[ "$content" =~ ^---[[:space:]] ]]; then
        # 检测是否包含知识库文档特征属性
        if [[ "$content" =~ (created:|project:|status:) ]]; then
            content_matched=true
        fi
    fi
fi

# ============================================================
# 综合判断
# ============================================================
should_suggest=false

# 优先级1：文件名匹配关键词
if [[ -n "$matched_type" ]]; then
    should_suggest=true
# 优先级2：路径在 docs/ 且内容有 frontmatter
elif [[ "$path_matched" == true && "$content_matched" == true ]]; then
    should_suggest=true
    matched_type="doc"
fi

# ============================================================
# 输出建议（使用 systemMessage 格式）
# ============================================================
if [[ "$should_suggest" == true ]]; then
    # 路径映射：根据类型推荐知识库子目录
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

    # 构建 systemMessage（Claude Code 识别的格式）
    message="检测到知识文档 ($matched_type)，建议使用 doc-writer skill 保存到知识库："
    message="$message\\n目标路径: $KNOWLEDGE_LIB/$target_dir"
    message="$message\\n当前路径: $file_path"
    message="$message\\n\\n提示：请先调用 obsidian:obsidian-markdown skill 获取完整的 Obsidian Markdown 语法规范"

    # 输出 JSON 格式的 systemMessage
    echo "{\"systemMessage\": \"$message\"}"
fi

exit 0
