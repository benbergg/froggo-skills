---
name: write-doc
description: "Manually create a document of specified type (requirement, design, task, plan, weekly, kpr, tech)"
arguments: "<类型> [名称]"
skill: doc-writer
---

# /write-doc 命令

手动创建指定类型的文档。

## 用法

```
/write-doc <类型> [名称]
```

## 示例

```
/write-doc requirement 用户积分系统   — 创建需求文档
/write-doc design 积分API设计         — 创建设计文档
/write-doc task 登录优化              — 创建任务文档
/write-doc weekly                     — 创建周报
/write-doc tech Redis缓存优化         — 创建技术笔记
```

---

**执行**：调用 `doc-writer` skill 处理
