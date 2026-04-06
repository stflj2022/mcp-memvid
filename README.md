# MCP-Memvid

MCP Server for Memvid - 给 Claude Code 提供长期记忆功能。

## ✨ 特性

- **跨会话记忆**: 在不同 Claude Code 窗口间共享记忆
- **自动恢复**: 突然中断后，新窗口自动恢复上下文
- **语义搜索**: 使用自然语言查找相关记忆
- **分类管理**: 按项目、偏好、决策、模式等分类存储
- **本地存储**: 所有数据保存在本地 `.mv2` 文件中

## 🚀 快速安装

```bash
# 克隆仓库
git clone https://github.com/stflj2022/mcp-memvid.git
cd mcp-memvid

# 安装依赖
npm install

# 构建
npm run build

# 运行安装脚本
chmod +x install.sh
./install.sh
```

## ⚙️ 配置

安装脚本会输出配置信息，将其添加到 `~/.claude.json` 的 `mcpServers` 部分：

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

| 工具 | 描述 |
|------|------|
| `memvid_auto_resume` | 自动恢复上次中断的对话 |
| `memvid_save_context` | 保存当前对话上下文 |
| `memvid_store` | 存储记忆 |
| `memvid_retrieve` | 按分类/标签检索 |
| `memvid_search` | 语义搜索 |
| `memvid_list` | 列出所有记忆 |
| `memvid_delete` | 删除记忆 |
| `memvid_summary` | 获取摘要 |

## 📖 使用示例

### 自动恢复（中断后继续）

新窗口打开时：
```
memvid_auto_resume()
```

输出示例：
```
🔄 恢复上次会话 (15分钟前)

📋 摘要: 正在开发 dice-mnemonic 项目，修复了 frozenEntropy 问题
🏷️ 主题: rust, crypto, bip39
📁 项目: dice-mnemonic

📝 最近记忆:
  • [project] dice-mnemonic 是基于物理骰子的 BIP39 助记词生成器...
  • [decision] 使用 frozenEntropy 确保助记词生成后的一致性...
```

### 保存上下文（防止中断丢失）

```
memvid_save_context(
  summary="正在开发 dice-mnemonic，刚修复了继续添加骰子后助记词不变的bug",
  topics=["rust", "crypto", "bip39"],
  projects=["/home/houwu/dice-mnemonic"]
)
```

### 存储长期记忆

```
# 存储用户偏好
memvid_store(content="用户喜欢简洁的回答，不需要总结", category="preference", importance=7)

# 存储项目信息
memvid_store(content="dice-mnemonic 是基于物理骰子的 BIP39 助记词生成器", category="project", tags=["rust", "crypto"])

# 存储技术决策
memvid_store(content="使用 frozenEntropy 确保助记词生成后的一致性，添加骰子时重置", category="decision", importance=8)
```

### 搜索记忆

```
memvid_search(query="用户偏好什么")
memvid_search(query="dice-memonic 的决策")
```

## 📂 数据位置

```
~/.claude-memories/
├── claude-memories.mv2   # Memvid 数据库
├── index.json            # 记忆索引
└── current-context.json  # 当前上下文（自动恢复用）
```

## 💡 工作流程

```
┌─────────────────┐
│  开始对话        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     重要节点      ┌──────────────┐
│  工作中...      │ ─────────────────▶│ save_context │
│                 │                   │ 保存上下文   │
└────────┬────────┘                   └──────────────┘
         │
         ▼                    意外中断/关闭窗口
┌─────────────────┐
│   中断 ❌       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  新窗口打开     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ auto_resume()   │ ───▶ 恢复上下文 ✓
└─────────────────┘
```

## 📄 License

MIT
