#!/usr/bin/env python3
"""UserPromptSubmit hook for knowledge library guidance.

This script is called by Claude Code when user submits a prompt.
It detects knowledge-related keywords and injects context to guide
Claude to use the appropriate skill (doc-reader or doc-writer).

Reference: https://docs.claude.com/en/docs/claude-code/hooks
"""

import json
import sys
import re

# Keywords that indicate QUERY intent (reading/searching)
QUERY_KEYWORDS = re.compile(
    r'(查一下|找一下|看看|搜索|查找|读取|查看|找文档|看文档|'
    r'之前的|上次的|相关的|有没有|是什么|怎么写的|'
    r'search|find|look|read|check)',
    re.IGNORECASE
)

# Keywords that indicate WRITE intent (creating/saving)
WRITE_KEYWORDS = re.compile(
    r'(写|创建|保存|输出|生成|记录|归档|整理|总结|'
    r'write|create|save|output|generate|document)',
    re.IGNORECASE
)

# Document type keywords
DOC_TYPE_KEYWORDS = re.compile(
    r'(需求|设计|计划|任务|资料|文档|知识库|周报|kpr|技术笔记|'
    r'requirement|design|plan|task|weekly|tech|document)',
    re.IGNORECASE
)

# Context message for QUERY intent
QUERY_CONTEXT = """📚 **检测到知识库查询意图**

请使用 `doc-reader` skill 来查询知识库文档：
- 调用 Skill 工具，skill 名称为 `doc-reader`
- 支持 frontmatter 属性查询（project、status、tags）
- 支持 wikilink 关联追踪
- 知识库路径：~/workspace/Knowledge-Library/

查询语法示例：
- type:design project:bytenew-llm - 按类型和项目
- zentao:T1234 - 按禅道 ID
- status:进行中 - 按状态"""

# Context message for WRITE intent
WRITE_CONTEXT = """📝 **检测到知识文档写入意图**

请使用 `doc-writer` skill 将文档保存到知识库：
- 调用 Skill 工具，skill 名称为 `doc-writer`
- 必须先调用 `obsidian:obsidian-markdown` skill 获取 Obsidian 语法规范
- 知识库路径：~/workspace/Knowledge-Library/

文档类型和目录映射：
| 类型 | 目录 | 命名格式 |
|------|------|----------|
| 需求 | 01-Requirements/ | yyyyMMdd-序号-名称.md |
| 任务 | 02-Tasks/ | yyyyMMdd-禅道ID-名称.md |
| 计划 | 03-Plans/ | yyyyMMdd-禅道ID-名称.md |
| 设计 | 04-Designs/ | yyyyMMdd-禅道ID-名称.md |
| 周报 | 05-Reports/weekly/ | YYYY-WXX.md |
| 技术 | 07-Tech/ | yyyyMMdd-主题-描述.md |

**必须包含的 frontmatter 属性：**
- created, updated, project, status, tags"""


def detect_intent(prompt: str) -> str | None:
    """Detect user intent from prompt.

    Returns:
        'query' for reading/searching
        'write' for creating/saving
        None if no knowledge-related intent detected
    """
    # Must contain document type keywords
    if not DOC_TYPE_KEYWORDS.search(prompt):
        return None

    has_query = QUERY_KEYWORDS.search(prompt)
    has_write = WRITE_KEYWORDS.search(prompt)

    # Prioritize write intent if both present
    if has_write:
        return 'write'
    elif has_query:
        return 'query'
    else:
        # Default to query if only doc type keywords present
        return 'query'


def main():
    """Main entry point for UserPromptSubmit hook."""
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)
        user_prompt = input_data.get('prompt', '')

        # Detect intent
        intent = detect_intent(user_prompt)

        if intent == 'query':
            context = QUERY_CONTEXT
        elif intent == 'write':
            context = WRITE_CONTEXT
        else:
            # No knowledge-related intent, exit silently
            sys.exit(0)

        # Output JSON with additionalContext
        output = {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": context
            }
        }
        print(json.dumps(output, ensure_ascii=False))

    except json.JSONDecodeError:
        # Invalid JSON input, silently ignore
        pass
    except Exception as e:
        # Log error but don't block
        print(json.dumps({
            "systemMessage": f"[froggo-skills] Hook warning: {e}"
        }), file=sys.stderr)

    # Always exit 0 to not block the prompt
    sys.exit(0)


if __name__ == '__main__':
    main()
