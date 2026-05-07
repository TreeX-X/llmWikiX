<div align="center">

**中文** · [English](./README.en.md)

# 📚 llmWikiX: 极简 LLM 知识库系统

llmWikiX 是一个极简的本地知识库工程，通过 MCP (Model Context Protocol) 服务器将 Markdown 知识文件暴露给外部 AI Agent 进行搜索与检索。

[![License](https://img.shields.io/badge/License-MIT-3B82F6?style=for-the-badge)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Protocol-10B981?style=for-the-badge)](https://modelcontextprotocol.io)

![GitHub Copilot](https://img.shields.io/badge/Copilot-Connect-6F42C1?style=flat-square&logo=github&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude_Code-Connect-D97706?style=flat-square&logo=anthropic&logoColor=white)
![Codex](https://img.shields.io/badge/Codex-Connect-10B981?style=flat-square&logo=openai&logoColor=white)

</div>

## 🌟 核心理念

- **零配置**：无需数据库、无需向量引擎、无需环境变量——纯文件系统驱动
- **MCP 标准协议**：通过 MCP 协议暴露知识库，任意支持 MCP 的 AI Agent 即可接入
- **Markdown 即一切**：用最通用的格式维护知识，`content/knowledge-base/` 放入 `.md` 文件即可开始使用

## 🏗 系统架构

```
content/knowledge-base/*.md   ← 用户维护的 Markdown 知识文件
        │
        ▼
content/wiki/                 ← wiki-creater Skill 自动生成
        │
        ▼
┌─────────────────────────┐
│  kb-mcp-server.mjs      │  MCP stdio 服务器 (纯文本索引 + 关键词搜索)
│  kb-mcp-http-server.mjs │  HTTP 桥接 (:8787)
└─────────┬───────────────┘
          │
          ▼
   外部 AI Agent / IDE / LLM 工具
   (GitHub Copilot, Claude Code, Codex, ...)
```

## ✨ 功能特性

- 🔍 **关键词搜索**：基于 title(×8) + description(×4) + content(×2) 的加权评分，精准命中
- 📖 **条目读取**：通过 `kb://` URI 或相对路径直接读取完整条目内容
- 📋 **条目列表**：按 scope (knowledge-base / wiki) 列出所有可用条目
- 🔄 **索引刷新**：支持 mtime 增量检测 + TTL 缓存(5 分钟)，也可手动强制刷新
- 🌐 **双传输模式**：stdio 原生 MCP + HTTP JSON-RPC 桥接，适配不同接入场景

## 📦 MCP 工具列表

| 工具 | 描述 |
|------|------|
| `search_knowledge_base` | 关键词搜索知识库，支持 scope 过滤 |
| `read_knowledge_base_entry` | 按 URI (`kb://scope/path`) 或相对路径读取条目 |
| `list_knowledge_base_entries` | 列出所有可用条目 |
| `refresh_index` | 强制刷新索引缓存 |

## 🚀 快速开始

### 1. 安装

```bash
git clone https://github.com/TreeX-X/llmWikiX.git
cd llmWikiX
npm install
```

### 2. 添加知识文件

将你的 Markdown 文件放入 `content/knowledge-base/`，支持子目录分类：

```
content/knowledge-base/
├── AI技巧/
│   └── prompt-engineering.md
├── 开发经验/
│   └── vscode-tips.md
└── 我的笔记.md
```

Markdown 文件 frontmatter 示例：

```yaml
---
title: "Prompt 工程技巧"
date: 2026-05-07
description: "常用 prompt 设计模式与最佳实践"
tags: ["AI", "prompt"]
---

# Prompt 工程技巧

正文内容...
```

### 3. 生成 Wiki 索引（可选）

使用 [wiki-creater Skill](https://github.com/TreeX-X/llmWikiX) 自动生成 `content/wiki/` 下的概念索引和来源索引。

### 4. 启动 MCP 服务

**stdio 模式**（推荐用于 IDE 集成）：

```bash
npm run mcp
```

**HTTP 模式**（用于网络调用）：

```bash
npm run mcp:http
# 监听 http://127.0.0.1:8787/mcp
```

## 🔧 IDE 集成配置

### GitHub Copilot / VS Code

在 `.vscode/mcp.json` 中添加：

```json
{
  "servers": {
    "llmwiki": {
      "command": "node",
      "args": ["scripts/kb-mcp-server.mjs"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

### Claude Desktop

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "llmwiki": {
      "command": "node",
      "args": ["/path/to/llmWikiX/scripts/kb-mcp-server.mjs"]
    }
  }
}
```

### HTTP 接入

```bash
# 健康检查
curl http://127.0.0.1:8787/health

# 搜索
curl -X POST http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_knowledge_base","arguments":{"query":"MCP","limit":5}}}'
```

## 📂 工程结构

```
llmWikiX/
├── package.json                  # 项目配置 (仅依赖 gray-matter)
├── .gitignore
├── README.md
├── LICENSE
├── content/
│   ├── knowledge-base/           # 👈 用户放入 .md 文件
│   │   └── _example.md           #    示例条目
│   └── wiki/                     #    wiki-creater 自动生成
│       ├── index.md
│       ├── concepts/
│       └── sources/
├── scripts/
│   ├── kb-mcp-server.mjs         # MCP stdio 服务器
│   └── kb-mcp-http-server.mjs    # HTTP 桥接服务器 (:8787)
└── docs/
```

## 📐 URI 规范

知识库条目通过 `kb://` URI 标识：

```
kb://knowledge-base/AI技巧/prompt-engineering.md
kb://wiki/concepts/软件.md
```

- `kb://` 固定协议前缀
- `knowledge-base` 或 `wiki` 为 scope
- 路径部分 URL 编码

## 🤝 与 WorkflowX 协作

llmWikiX 可无缝接入 [WorkflowX](https://github.com/TreeX-X/workflowX) 多智能体工作流：

- **PlannerX** 产出的 PRD 文档可直接放入 `content/knowledge-base/`
- **CoderX** 在开发过程中产生的知识沉淀，通过 MCP 暴露给后续智能体
- **EvaluatorX** 可通过 MCP 搜索知识库获取上下文进行定向评估

## 🌟 关于

llmWikiX 是 [TreeX-AI](https://github.com/TreeX-X) 生态中的知识基础设施组件，旨在为 AI 辅助开发提供轻量、可扩展的知识管理底座。

欢迎任何形式的讨论、建议与贡献！
如何贡献：Fork 本仓库，提交 Pull Request，或直接在 Issues 中提出你的想法。

公众号：[TreeX-AI]

如果开源对你有帮助，欢迎点亮⭐，让更多人加入一起探索 AI 知识管理的未来！

---

<div align="center">

[MIT License](./LICENSE) · 自由使用 / 修改 / 再分发

Made by [@TreeX-X](https://github.com/TreeX-X)

</div>