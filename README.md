# MCP-Memvid

MCP Server for Memvid - 给 Claude Code 提供长期记忆功能。

## 功能

- **跨会话记忆**: 在不同 Claude Code 窗口间共享记忆
- **语义搜索**: 使用自然语言查找相关记忆
- **分类管理**: 按项目、偏好、决策、模式等分类存储
- **本地存储**: 所有数据保存在本地 `.mv2` 文件中

## 安装

```bash
cd /home/houwu/mcp-memvid
npm install
npm run build
```

## 配置

Claude Code 配置 (`~/.claude/settings.json`)：

```json
{
  "mcpServers": {
    "memvid": {
      "command": "node",
      "args": ["/home/houwu/mcp-memvid/dist/index.js"]
    }
  }
}
```

## 工具

| 工具 | 描述 |
|------|------|
| `memvid_store` | 存储记忆 |
| `memvid_retrieve` | 按分类/标签检索 |
| `memvid_search` | 语义搜索 |
| `memvid_list` | 列出所有记忆 |
| `memvid_delete` | 删除记忆 |
| `memvid_summary` | 获取摘要 |

## 使用示例

```
# 存储用户偏好
memvid_store(content="User prefers concise responses without summaries", category="preference")

# 存储项目信息
memvid_store(content="dice-mnemonic is a BIP39 mnemonic generator using physical dice", category="project", tags=["rust", "crypto"])

# 存储决策
memvid_store(content="Used frozenEntropy to ensure mnemonic consistency after generation", category="decision", importance=8)

# 搜索记忆
memvid_search(query="what user prefers")

# 获取摘要
memvid_summary()
```

## 数据位置

- 记忆文件: `~/.claude-memories/claude-memories.mv2`
- 索引文件: `~/.claude-memories/index.json`
