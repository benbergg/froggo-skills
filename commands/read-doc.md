---
name: read-doc
description: "Search and read documents from Knowledge Library with query filters"
arguments: "[查询条件]"
skill: doc-reader
---

# /read-doc 命令

从知识库搜索和读取文档。

## 用法

```
/read-doc [查询条件]
```

## 示例

```
/read-doc type:design           — 列出所有设计文档
/read-doc project:bytenew-llm   — 列出指定项目文档
/read-doc 登录功能               — 搜索包含关键词的文档
/read-doc zentao:T1234          — 查找关联禅道任务的文档
/read-doc type:design project:bytenew-llm  — 组合查询
```

---

**执行**：调用 `doc-reader` skill 处理
