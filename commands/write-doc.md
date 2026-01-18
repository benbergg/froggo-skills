---
name: write-doc
description: "手动创建指定类型的文档"
arguments: "<类型> [名称]"
---

# /write-doc 命令

手动创建指定类型的文档。

## 用法

```
/write-doc <类型> [名称]
```

## 类型可选值

| 类型 | 说明 | 输出目录 |
|------|------|----------|
| `requirement` | 需求文档 | `01-Requirements/` |
| `task` | 任务文档 | `02-Tasks/` |
| `plan` | 开发计划 | `03-Plans/` |
| `design` | 设计文档 | `04-Designs/` |
| `weekly` | 周报 | `05-Reports/weekly/` |
| `kpr` | KPR考核 | `05-Reports/KPR/` |
| `tech` | 技术笔记 | `07-Tech/` |

## 示例

```
/write-doc requirement 用户积分系统
/write-doc design 积分API设计
/write-doc weekly
/write-doc tech Redis缓存优化
```

## 执行流程

1. 解析文档类型和名称
2. 根据类型确定输出目录和命名格式
3. 读取对应模板
4. 生成文件名（自动填充日期）
5. 创建文档并填充 frontmatter
6. 如有名称参数，填充标题

## 交互模式

不带参数时进入交互模式：

```
/write-doc

请选择文档类型：
1. 需求文档
2. 任务文档
3. 开发计划
4. 设计文档
5. 周报
6. KPR考核
7. 技术笔记

请输入文档名称：
```
