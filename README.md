# MCP-Memvid with LCM

MCP Server for Memvid - 给 Claude Code 提供长期记忆和**无损上下文管理**功能。

## ✨ 特性

### LCM (Lossless Context Management)
- **自动压缩**: 对话超过阈值时自动摘要旧消息
- **完全集成**: 所有数据存储在单个 Memvid `.mv2` 文件中
- **持久化**: 消息、摘要、记忆都在 Memvid 中，不会丢失
- **智能搜索**: 统一搜索所有历史对话和记忆

### 长期记忆
- **跨会话记忆**: 在不同 Claude Code 窗口间共享记忆
- **语义搜索**: 使用自然语言查找相关记忆
- **分类管理**: 按项目、偏好、决策、模式等分类存储

基于 [LCM 论文](https://papers.voltropy.com/LCM) 和 [lossless-claw](https://github.com/Martian-Engineering/lossless-claw) 项目。

## 🚀 快速安装

```bash
git clone https://github.com/stflj2022/mcp-memvid.git
cd mcp-memvid
npm install
npm run build
chmod +x install.sh
./install.sh
```

## ⚙️ 配置

将以下内容添加到 `~/.claude.json` 的 `mcpServers` 部分：

```json
{
  "mcpServers": {
    "memvid": {
      "type": "stdio",
      "command": "node",
      "args": ["$HOME/.claude/mcp-memvid/dist/index.js"]
    }
  }
}
```

## 🛠️ 工具

### LCM 工具

| 工具 | 描述 |
|------|------|
| `lcm_status` | 查看上下文状态和压缩建议 |
| `lcm_compact` | 执行上下文压缩 |
| `lcm_list_summaries` | 列出所有摘要 |
| `lcm_search` | 在消息和摘要中搜索 |

### 记忆工具

| 工具 | 描述 |
|------|------|
| `memvid_auto_resume` | 自动恢复上次中断的对话 |
| `memvid_save_context` | 保存当前对话上下文 |
| `memvid_store` | 存储长期记忆 |
| `memvid_search` | 搜索长期记忆 |
| `memvid_summary` | 获取记忆摘要 |

## 📖 使用示例

### 查看上下文状态

```
lcm_status()
```

输出：
```
📊 LCM 状态

📝 当前消息: 150 条
🔤 估算 tokens: 180,000
📦 已创建摘要: 3 个
🎯 压缩阈值: 150,000 (75%)

⚠️  建议执行压缩
   可压缩约 86 条消息
   运行: lcm_compact()
```

### 执行压缩

```
lcm_compact()
```

### 搜索历史

```
lcm_search(query="dice-memonic bug")
```

### 自动恢复（中断后继续）

```
memvid_auto_resume()
```

### 存储长期记忆

```
memvid_store(content="用户偏好简洁回答", category="preference", importance=7)
```

## 💡 数据架构

```
┌─────────────────────────────────────────┐
│         ~/.claude-memories/             │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │     claude-memories.mv2           │  │
│  │     (Memvid Database)             │  │
│  │                                   │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  Messages (type:message)    │  │  │
│  │  │  - role, content, timestamp │  │  │
│  │  │  - compressed flag          │  │  │
│  │  └─────────────────────────────┘  │  │
│  │                                   │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  Summaries (type:summary)  │  │  │
│  │  │  - content, sourceIds       │  │  │
│  │  │  - depth, topics            │  │  │
│  │  └─────────────────────────────┘  │  │
│  │                                   │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  Memories (type:memory)    │  │  │
│  │  │  - content, category        │  │  │
│  │  │  - tags, importance         │  │  │
│  │  └─────────────────────────────┘  │  │
│  │                                   │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │  Context Snapshots          │  │  │
│  │  └─────────────────────────────┘  │  │
│  │                                   │  │
│  └───────────────────────────────────┘  │
│                                         │
│  context-cache.json (仅用于快速启动缓存)  │
└─────────────────────────────────────────┘
```

## 🎯 解决的问题

| 问题 | 解决方案 |
|------|----------|
| 上下文超限中断 | LCM 自动压缩，延长单次会话 |
| 中断后无法继续 | `memvid_auto_resume()` 恢复上下文 |
| 旧对话丢失 | 所有内容保存在 Memvid，可搜索 |
| 跨会话记忆 | Memvid 长期存储 + 语义搜索 |
| 数据分散 | 单一 `.mv2` 文件存储所有数据 |

## 📂 数据位置

```
~/.claude-memories/
├── claude-memories.mv2      # 所有数据（消息、摘要、记忆）
└── context-cache.json       # 启动缓存（可删除，会重建）
```

## 📄 License

MIT
