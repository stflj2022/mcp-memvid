# MCP-Memvid with LCM

MCP Server for Memvid - 给 Claude Code 提供长期记忆和**无损上下文管理**功能。

## ✨ 特性

### 长期记忆
- **跨会话记忆**: 在不同 Claude Code 窗口间共享记忆
- **语义搜索**: 使用自然语言查找相关记忆
- **分类管理**: 按项目、偏好、决策、模式等分类存储

### LCM (Lossless Context Management)
- **自动压缩**: 对话超过阈值时自动摘要旧消息
- **分层摘要**: 多级摘要形成 DAG 结构
- **无损恢复**: 可展开任意摘要恢复原始对话
- **智能检索**: 根据当前需求检索相关历史

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
| `lcm_expand` | 展开摘要恢复详情 |
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

📝 消息: 150 条
📦 摘要: 3 个
🔤 估算 tokens: 180000
🎯 上下文阈值: 150000 (75%)

⚠️  建议执行压缩: lcm_compact()
   可压缩约 86 条消息
```

### 执行压缩

```
lcm_compact()
```

或强制压缩：
```
lcm_compact(force=true)
```

### 展开摘要

```
lcm_expand(summaryId="abc123...")
```

### 搜索历史

```
lcm_search(query="dice-memonic bug")
```

### 自动恢复（中断后继续）

```
memvid_auto_resume()
```

## 💡 工作原理

```
┌─────────────────────────────────────────────────────┐
│                  当前会话上下文                      │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │ 摘要A   │ │ 摘要B   │ │ 旧消息  │ │ 新消息  │   │
│  │ (DAG)   │ │ (DAG)   │ │(保护区) │ │(活动区) │   │
│  └────┬────┘ └────┬────┘ └─────────┘ └─────────┘   │
│       │            │                                │
│       ▼            ▼                                │
│  [原始消息]    [原始消息]                            │
│       │            │                                │
│       └────────────┴────────────────────────────┐   │
│                   │                               │   │
│                   ▼                               │   │
└───────────────────┼───────────────────────────────┘
                    │
                    ▼
              ┌─────────────┐
              │   Memvid    │
              │  (.mv2)     │
              └─────────────┘
```

### 压缩流程

1. **触发条件**: 上下文达到 75% 阈值且消息数 > 20
2. **保护机制**: 最近 64 条消息不被压缩
3. **摘要生成**: 按主题分组，提取关键点和决策
4. **DAG 构建**: 摘要可链接回源消息，支持递归压缩

### 恢复流程

1. 中断后打开新窗口
2. `memvid_auto_resume()` 恢复上下文
3. `lcm_expand()` 展开需要的摘要
4. 继续工作

## 📂 数据位置

```
~/.claude-memories/
├── claude-memories.mv2   # Memvid 数据库
├── index.json            # 记忆索引
├── current-context.json  # 当前上下文
└── lcm-state.json        # LCM 状态（消息、摘要）
```

## 🎯 解决的问题

| 问题 | 解决方案 |
|------|----------|
| 上下文超限中断 | LCM 自动压缩，延长单次会话 |
| 中断后无法继续 | `memvid_auto_resume()` 恢复上下文 |
| 旧对话丢失 | 无损摘要，可随时展开查看 |
| 跨会话记忆 | Memvid 长期存储 + 语义搜索 |

## 📄 License

MIT
