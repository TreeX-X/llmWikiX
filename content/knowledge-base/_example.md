---
title: "示例知识条目"
date: 2026-05-07
description: "这是一个示例条目, 展示如何编写知识库内容。"
tags: ["示例", "入门"]
---

# 示例知识条目

将你的 markdown 文件放入 `content/knowledge-base/` 目录。

## 支持的结构

- 支持子目录分类, 如 `content/knowledge-base/AI技巧/xxx.md`
- frontmatter 中的 `title`, `date`, `description`, `tags` 字段均为可选
- 如果不填写 title, 将自动从文件名或第一个标题提取

## 运行方式

```bash
# 生成 wiki 索引
npm run wiki:generate

# 启动 MCP 服务
npm run mcp
```
