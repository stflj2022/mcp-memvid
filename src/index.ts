#!/usr/bin/env node

/**
 * MCP Server for Memvid - Long-term memory with LCM for Claude Code
 *
 * Lossless Context Management:
 * - Automatically compress old messages into summaries when context approaches limit
 * - Multi-level summaries (leaf -> condensed) forming a DAG
 * - Expand summaries to recover original detail
 * - Smart retrieval based on current conversation needs
 *
 * Based on LCM paper: https://papers.voltropy.com/LCM
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { create, open } from "@memvid/sdk";
import type { Memvid, PutInput, FindInput } from "@memvid/sdk";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// ============================================================================
// Configuration
// ============================================================================

const MEMORY_DIR = path.join(os.homedir(), ".claude-memories");
const MEMORY_FILE = path.join(MEMORY_DIR, "claude-memories.mv2");
const MEMORY_INDEX_FILE = path.join(MEMORY_DIR, "index.json");
const CONTEXT_FILE = path.join(MEMORY_DIR, "current-context.json");
const LCM_STATE_FILE = path.join(MEMORY_DIR, "lcm-state.json");

// LCM Configuration
const LCM_CONFIG = {
  // Trigger compaction when context reaches this fraction of window (default 0.75 = 75%)
  contextThreshold: 0.75,

  // Number of recent messages protected from compaction
  freshTailCount: 64,

  // Minimum messages before triggering compression
  minMessagesForCompression: 20,

  // Target tokens for leaf summaries (compressed once)
  leafTargetTokens: 1200,

  // Target tokens for condensed summaries (compressed multiple times)
  condensedTargetTokens: 2000,

  // Minimum messages per leaf summary
  leafMinFanout: 8,

  // Minimum summaries per condensed node
  condensedMinFanout: 4,

  // Maximum tokens for expansion queries
  maxExpandTokens: 4000,
};

// ============================================================================
// Types
// ============================================================================

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  tokenId: string;
}

interface SummaryNode {
  id: string;
  type: "leaf" | "condensed";
  content: string;
  sourceIds: string[]; // Message IDs or summary IDs that were summarized
  timestamp: string;
  depth: number;
  tokenCount: number;
  topics: string[];
  metadata: Record<string, unknown>;
}

interface MemoryIndex {
  memories: Record<string, {
    category: string;
    tags: string[];
    importance: number;
    timestamp: string;
    content: string;
  }>;
  currentContext?: {
    sessionId: string;
    timestamp: string;
    summary: string;
    topics: string[];
    lastProjects: string[];
  };
  lcmState?: {
    messages: Message[];
    summaries: SummaryNode[];
    compressedMessageIds: string[];
    totalTokens: number;
    lastCompactionTime?: string;
  };
}

// ============================================================================
// State
// ============================================================================

let memvid: Memvid | null = null;
let memoryIndex: MemoryIndex = { memories: {} };
let currentSessionId: string;

// ============================================================================
// Utilities
// ============================================================================

function loadIndex(): void {
  if (fs.existsSync(MEMORY_INDEX_FILE)) {
    try {
      memoryIndex = JSON.parse(fs.readFileSync(MEMORY_INDEX_FILE, "utf-8"));
    } catch (e) {
      memoryIndex = { memories: {} };
    }
  }

  // Load LCM state
  if (fs.existsSync(LCM_STATE_FILE)) {
    try {
      const lcmState = JSON.parse(fs.readFileSync(LCM_STATE_FILE, "utf-8"));
      memoryIndex.lcmState = lcmState;
    } catch (e) {
      // Initialize fresh state
    }
  }

  // Initialize LCM state if not exists
  if (!memoryIndex.lcmState) {
    memoryIndex.lcmState = {
      messages: [],
      summaries: [],
      compressedMessageIds: [],
      totalTokens: 0,
    };
  }
}

function saveIndex(): void {
  fs.writeFileSync(MEMORY_INDEX_FILE, JSON.stringify(memoryIndex, null, 2));
  if (memoryIndex.lcmState) {
    fs.writeFileSync(LCM_STATE_FILE, JSON.stringify(memoryIndex.lcmState, null, 2));
  }
}

function saveContext(summary: string, topics: string[] = [], projects: string[] = []): void {
  memoryIndex.currentContext = {
    sessionId: currentSessionId,
    timestamp: new Date().toISOString(),
    summary,
    topics,
    lastProjects: projects,
  };
  saveIndex();
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(memoryIndex.currentContext, null, 2));
}

function estimateTokens(text: string): number {
  // Rough estimate: 1 token ≈ 4 characters for English, 2-3 for Chinese
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 2 + otherChars / 4);
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ============================================================================
// LCM Core Functions
// ============================================================================

/**
 * Add a message to the context
 */
async function addMessage(role: "user" | "assistant" | "system", content: string): Promise<string> {
  const msg: Message = {
    role,
    content,
    timestamp: new Date().toISOString(),
    tokenId: generateId(),
  };

  if (!memoryIndex.lcmState) {
    memoryIndex.lcmState = {
      messages: [],
      summaries: [],
      compressedMessageIds: [],
      totalTokens: 0,
    };
  }

  memoryIndex.lcmState.messages.push(msg);
  memoryIndex.lcmState.totalTokens += estimateTokens(content);
  saveIndex();

  return msg.tokenId;
}

/**
 * Get current context (messages + summaries)
 */
function getCurrentContext(maxTokens?: number): { messages: Message[]; summaries: SummaryNode[]; shouldCompact: boolean } {
  if (!memoryIndex.lcmState) {
    return { messages: [], summaries: [], shouldCompact: false };
  }

  const state = memoryIndex.lcmState;

  // Get uncompressed messages
  const uncompressedMessages = state.messages.filter(
    m => m.tokenId && !state.compressedMessageIds.includes(m.tokenId)
  );

  // Calculate if we should compact
  const totalTokens = state.totalTokens;
  const shouldCompact = totalTokens > (maxTokens || 200000) * LCM_CONFIG.contextThreshold
    && uncompressedMessages.length > LCM_CONFIG.minMessagesForCompression;

  return {
    messages: uncompressedMessages,
    summaries: state.summaries,
    shouldCompact,
  };
}

/**
 * Perform compaction - summarize old messages
 */
async function performCompaction(force: boolean = false): Promise<SummaryNode | null> {
  if (!memvid || !memoryIndex.lcmState) {
    return null;
  }

  const state = memoryIndex.lcmState;
  const messages = state.messages.filter(
    m => m.tokenId && !state.compressedMessageIds.includes(m.tokenId)
  );

  // Keep recent messages safe
  const safeCount = Math.min(LCM_CONFIG.freshTailCount, Math.floor(messages.length / 2));
  const toCompress = messages.slice(0, messages.length - safeCount);

  if (toCompress.length < LCM_CONFIG.leafMinFanout && !force) {
    return null;
  }

  // Create summary
  const summaryText = await createSummary(toCompress);
  const summaryNode: SummaryNode = {
    id: generateId(),
    type: "leaf",
    content: summaryText,
    sourceIds: toCompress.map(m => m.tokenId!).filter(Boolean),
    timestamp: new Date().toISOString(),
    depth: 1,
    tokenCount: estimateTokens(summaryText),
    topics: extractTopics(toCompress),
    metadata: {
      messageCount: toCompress.length,
      timeSpan: {
        start: toCompress[0]?.timestamp,
        end: toCompress[toCompress.length - 1]?.timestamp,
      },
    },
  };

  // Mark messages as compressed
  state.compressedMessageIds.push(...summaryNode.sourceIds);
  state.summaries.push(summaryNode);
  state.totalTokens = state.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    - summaryNode.sourceIds.reduce((sum, id) => {
      const msg = state.messages.find(m => m.tokenId === id);
      return sum + (msg ? estimateTokens(msg.content) : 0);
    }, 0)
    + state.summaries.reduce((sum, s) => sum + s.tokenCount, 0);

  saveIndex();

  // Also store in Memvid for persistence
  await memvid.put({
    text: summaryText,
    metadata: {
      type: "summary",
      summaryId: summaryNode.id,
      sourceIds: summaryNode.sourceIds,
      topics: summaryNode.topics,
      depth: summaryNode.depth,
    },
  });

  return summaryNode;
}

/**
 * Create a summary from messages
 */
async function createSummary(messages: Message[]): Promise<string> {
  if (messages.length === 0) return "";

  // Group by topic/conversation flow
  const groups = groupMessages(messages);

  let summary = `## 对话摘要 (${new Date().toLocaleString()})\n\n`;

  // Overview
  summary += `**时间范围**: ${messages[0]?.timestamp} - ${messages[messages.length - 1]?.timestamp}\n`;
  summary += `**消息数**: ${messages.length}\n\n`;

  // Topics covered
  const topics = extractTopics(messages);
  if (topics.length > 0) {
    summary += `**讨论主题**: ${topics.join(", ")}\n\n`;
  }

  // Key points per group
  summary += `### 关键内容\n\n`;
  for (const group of groups) {
    summary += `#### ${group.topic}\n`;
    for (const point of group.points) {
      summary += `- ${point}\n`;
    }
    summary += `\n`;
  }

  // Important decisions/items
  const decisions = extractDecisions(messages);
  if (decisions.length > 0) {
    summary += `### 重要决策\n\n`;
    for (const decision of decisions) {
      summary += `- ${decision}\n`;
    }
    summary += `\n`;
  }

  return summary;
}

/**
 * Group messages by topic
 */
function groupMessages(messages: Message[]): Array<{ topic: string; points: string[] }> {
  // Simple grouping by detecting topic changes
  const groups: Array<{ topic: string; points: string[] }> = [];
  let currentTopic = "开始";

  for (const msg of messages) {
    const content = msg.content.substring(0, 200); // Check start of message

    // Detect topic keywords
    if (content.includes("dice-mnemonic") || content.includes("助记词")) {
      if (currentTopic !== "dice-mnemonic 项目") {
        groups.push({ topic: "dice-mnemonic 项目", points: [] });
        currentTopic = "dice-mnemonic 项目";
      }
    } else if (content.includes("MCP") || content.includes("memvid")) {
      if (currentTopic !== "MCP-Memvid 开发") {
        groups.push({ topic: "MCP-Memvid 开发", points: [] });
        currentTopic = "MCP-Memvid 开发";
      }
    } else if (content.includes("修复") || content.includes("bug")) {
      if (currentTopic !== "问题修复") {
        groups.push({ topic: "问题修复", points: [] });
        currentTopic = "问题修复";
      }
    }

    // Add key point
    const group = groups.find(g => g.topic === currentTopic) || groups[groups.length - 1];
    if (group) {
      const point = msg.content
        .substring(0, 100)
        .replace(/\n/g, " ")
        .trim();
      if (point && !group.points.includes(point)) {
        group.points.push(point.substring(0, 80) + (point.length >= 80 ? "..." : ""));
      }
    }
  }

  return groups;
}

/**
 * Extract topics from messages
 */
function extractTopics(messages: Message[]): string[] {
  const topics = new Set<string>();
  const keywords = {
    "rust": ["rust", "cargo", "tokio", "serde"],
    "crypto": ["加密", "密码", "bip39", "助记词", "mnemonic", "bitcoin", "ethereum"],
    "web": ["html", "css", "javascript", "react", "vue", "前端"],
    "mcp": ["mcp", "memvid", "context", "记忆"],
    "git": ["git", "github", "commit", "push", "pull"],
  };

  const text = messages.map(m => m.content.toLowerCase()).join(" ");

  for (const [topic, words] of Object.entries(keywords)) {
    if (words.some(w => text.includes(w))) {
      topics.add(topic);
    }
  }

  return Array.from(topics);
}

/**
 * Extract decisions from messages
 */
function extractDecisions(messages: Message[]): string[] {
  const decisions: string[] = [];
  const decisionPatterns = [
    /决定[：:]\s*(.+)/,
    /决策[：:]\s*(.+)/,
    /使用\s+(.+)/,
    /选择\s+(.+)/,
  ];

  for (const msg of messages) {
    for (const pattern of decisionPatterns) {
      const match = msg.content.match(pattern);
      if (match) {
        decisions.push(match[1].trim());
      }
    }
  }

  return decisions.slice(0, 5); // Top 5 decisions
}

/**
 * Expand a summary to recover detail
 */
async function expandSummary(summaryId: string): Promise<Message[]> {
  if (!memoryIndex.lcmState) {
    return [];
  }

  const state = memoryIndex.lcmState;
  const summary = state.summaries.find(s => s.id === summaryId);

  if (!summary) {
    return [];
  }

  // Get original messages
  const messages = state.messages.filter(m =>
    m.tokenId && summary.sourceIds.includes(m.tokenId!)
  );

  return messages;
}

/**
 * Search summaries by query
 */
function searchSummaries(query: string): SummaryNode[] {
  if (!memoryIndex.lcmState) {
    return [];
  }

  const state = memoryIndex.lcmState;
  const queryLower = query.toLowerCase();

  return state.summaries.filter(s =>
    s.content.toLowerCase().includes(queryLower) ||
    s.topics.some(t => t.toLowerCase().includes(queryLower))
  );
}

// ============================================================================
// Memvid Initialization
// ============================================================================

async function initMemvid(): Promise<string | null> {
  try {
    loadIndex();
    currentSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);

    if (fs.existsSync(MEMORY_FILE)) {
      memvid = await open(MEMORY_FILE, "basic");
      console.error(`[MCP-Memvid] Opened: ${MEMORY_FILE}`);
    } else {
      memvid = await create(MEMORY_FILE, "basic");
      console.error(`[MCP-Memvid] Created: ${MEMORY_FILE}`);
    }

    if (memoryIndex.currentContext) {
      const ctx = memoryIndex.currentContext;
      console.error(`[MCP-Memvid] Found context from ${new Date(ctx.timestamp).toLocaleString()}`);
      return JSON.stringify(ctx);
    }
    return null;
  } catch (error) {
    console.error("[MCP-Memvid] Init error:", error);
    throw error;
  }
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new Server(
  {
    name: "mcp-memvid-server",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "lcm_status",
        description: `[LCM] 查看当前上下文状态和压缩建议。

返回：
- 当前消息数量
- 累计 token 数
- 摘要节点数量
- 是否需要压缩
- 压缩建议`,
        inputSchema: {
          type: "object",
          properties: {
            maxTokens: {
              type: "number",
              description: "上下文窗口大小 (默认 200000 for Opus 1M)",
              default: 200000,
            },
          },
        },
      },
      {
        name: "lcm_compact",
        description: `[LCM] 执行上下文压缩，将旧消息摘要化。

压缩后的消息会被标记，但仍可通过 lcm_expand 恢复。

参数：
- force: 强制压缩，即使未达到阈值`,
        inputSchema: {
          type: "object",
          properties: {
            force: {
              type: "boolean",
              description: "强制压缩",
              default: false,
            },
          },
        },
      },
      {
        name: "lcm_expand",
        description: `[LCM] 展开摘要，恢复原始消息详情。

可以查看被摘要的完整对话内容。`,
        inputSchema: {
          type: "object",
          properties: {
            summaryId: {
              type: "string",
              description: "要展开的摘要ID",
            },
          },
          required: ["summaryId"],
        },
      },
      {
        name: "lcm_list_summaries",
        description: `[LCM] 列出所有摘要节点。`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "lcm_search",
        description: `[LCM] 在消息和摘要中搜索。`,
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索查询",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "memvid_auto_resume",
        description: `[AUTO] 检查并恢复之前中断的对话上下文。`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "memvid_save_context",
        description: `保存当前对话上下文（用于意外中断后恢复）。`,
        inputSchema: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "当前对话摘要（1-2句话）",
            },
            topics: {
              type: "array",
              items: { type: "string" },
              description: "当前讨论的主题列表",
            },
            projects: {
              type: "array",
              items: { type: "string" },
              description: "当前处理的项目路径或名称",
            },
          },
          required: ["summary"],
        },
      },
      {
        name: "memvid_store",
        description: `存储一条长期记忆。`,
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "记忆内容",
            },
            category: {
              type: "string",
              description: "分类",
              enum: ["project", "preference", "decision", "pattern", "context", "note"],
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "标签",
            },
            importance: {
              type: "number",
              description: "重要性 (1-10, 默认5)",
              minimum: 1,
              maximum: 10,
            },
          },
          required: ["content"],
        },
      },
      {
        name: "memvid_search",
        description: `搜索长期记忆。`,
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索查询",
            },
            limit: {
              type: "number",
              description: "最大结果数 (默认5)",
              default: 5,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "memvid_summary",
        description: "获取记忆摘要",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!memvid) {
    return {
      content: [{ type: "text", text: "❌ Memvid not initialized" }],
      isError: true,
    };
  }

  try {
    switch (name) {
      // ========================================================================
      // LCM Tools
      // ========================================================================

      case "lcm_status": {
        const { maxTokens = 200000 } = args as any;
        const context = getCurrentContext(maxTokens);

        let status = `📊 LCM 状态\n\n`;
        status += `📝 消息: ${context.messages.length} 条\n`;
        status += `📦 摘要: ${context.summaries.length} 个\n`;
        status += `🔤 估算 tokens: ${memoryIndex.lcmState?.totalTokens || 0}\n`;
        status += `🎯 上下文阈值: ${maxTokens * LCM_CONFIG.contextThreshold} (${LCM_CONFIG.contextThreshold * 100}%)\n\n`;

        if (context.shouldCompact) {
          status += `⚠️  建议执行压缩: lcm_compact()\n`;
          status += `   可压缩约 ${context.messages.length - LCM_CONFIG.freshTailCount} 条消息`;
        } else {
          status += `✅ 无需压缩`;
        }

        return { content: [{ type: "text", text: status }] };
      }

      case "lcm_compact": {
        const { force = false } = args as any;
        const summary = await performCompaction(force);

        if (!summary) {
          return {
            content: [{ type: "text", text: "ℹ️  没有足够的消息需要压缩" }],
          };
        }

        let result = `✅ 压缩完成\n\n`;
        result += `📦 摘要ID: ${summary.id}\n`;
        result += `📝 压缩消息数: ${summary.sourceIds.length}\n`;
        result += `🔤 摘要 tokens: ${summary.tokenCount}\n`;
        result += `🏷️  主题: ${summary.topics.join(", ") || "无"}\n\n`;
        result += `💾 使用 lcm_expand("${summary.id}") 查看详情`;

        return { content: [{ type: "text", text: result }] };
      }

      case "lcm_expand": {
        const { summaryId } = args as any;
        const messages = await expandSummary(summaryId);

        if (messages.length === 0) {
          return {
            content: [{ type: "text", text: "❌ 未找到摘要或原始消息" }],
          };
        }

        let result = `📖 展开摘要 (${summaryId})\n\n`;
        result += `原始消息 (${messages.length} 条):\n\n`;

        for (const msg of messages.slice(0, 20)) { // Limit to first 20
          const role = msg.role === "user" ? "👤 用户" : "🤖 助手";
          result += `${role} [${new Date(msg.timestamp).toLocaleTimeString()}]:\n`;
          result += `${msg.content.substring(0, 200)}${msg.content.length > 200 ? "..." : ""}\n\n`;
        }

        if (messages.length > 20) {
          result += `... 还有 ${messages.length - 20} 条消息`;
        }

        return { content: [{ type: "text", text: result }] };
      }

      case "lcm_list_summaries": {
        if (!memoryIndex.lcmState?.summaries.length) {
          return {
            content: [{ type: "text", text: "还没有摘要" }],
          };
        }

        let result = `📋 摘要列表 (${memoryIndex.lcmState.summaries.length} 个)\n\n`;

        for (const summary of memoryIndex.lcmState.summaries) {
          result += `• [${summary.id}] ${summary.type} (深度: ${summary.depth})\n`;
          result += `  📝 ${summary.sourceIds.length} 条消息\n`;
          result += `  🔤 ${summary.tokenCount} tokens\n`;
          result += `  🏷️  ${summary.topics.join(", ") || "无主题"}\n`;
          result += `  📅 ${new Date(summary.timestamp).toLocaleString()}\n\n`;
        }

        return { content: [{ type: "text", text: result }] };
      }

      case "lcm_search": {
        const { query } = args as any;

        // Search in summaries
        const summaryResults = searchSummaries(query);

        // Also search in Memvid for long-term memories
        const findOpts: FindInput = { mode: "lex" };
        const memvidResults = await memvid.find(query, findOpts);

        let result = `🔍 搜索: "${query}"\n\n`;

        if (summaryResults.length > 0) {
          result += `📦 摘要 (${summaryResults.length} 个):\n\n`;
          for (const s of summaryResults) {
            result += `• [${s.id}] ${s.type}\n`;
            result += `  ${s.content.substring(0, 100)}...\n\n`;
          }
        }

        if (memvidResults.hits?.length > 0) {
          result += `💾 长期记忆 (${memvidResults.hits.length} 个):\n\n`;
          for (const hit of memvidResults.hits.slice(0, 5)) {
            result += `• [${hit.frame_id}]\n`;
            if (hit.snippet) {
              result += `  ${hit.snippet}\n`;
            }
            result += `\n`;
          }
        }

        if (summaryResults.length === 0 && (!memvidResults.hits || memvidResults.hits.length === 0)) {
          result += "没有找到匹配内容";
        }

        return { content: [{ type: "text", text: result }] };
      }

      // ========================================================================
      // Memory Tools
      // ========================================================================

      case "memvid_auto_resume": {
        if (!memoryIndex.currentContext) {
          return {
            content: [{ type: "text", text: "✅ 没有保存的上下文，这是一个新会话。" }],
          };
        }

        const ctx = memoryIndex.currentContext;
        const timeAgo = Math.floor((Date.now() - new Date(ctx.timestamp).getTime()) / 60000);

        let message = `🔄 恢复上次会话 (${timeAgo}分钟前)\n\n`;
        message += `📋 摘要: ${ctx.summary}\n`;
        if (ctx.topics && ctx.topics.length > 0) {
          message += `🏷️  主题: ${ctx.topics.join(", ")}\n`;
        }
        if (ctx.lastProjects && ctx.lastProjects.length > 0) {
          message += `📁 项目: ${ctx.lastProjects.join(", ")}\n`;
        }

        // Also show LCM status
        if (memoryIndex.lcmState) {
          message += `\n📊 LCM 状态:\n`;
          message += `  消息: ${memoryIndex.lcmState.messages.length} 条\n`;
          message += `  摘要: ${memoryIndex.lcmState.summaries.length} 个\n`;
        }

        return {
          content: [{ type: "text", text: message }],
        };
      }

      case "memvid_save_context": {
        const { summary, topics = [], projects = [] } = args as any;
        saveContext(summary, topics, projects);
        return {
          content: [{ type: "text", text: "✅ 上下文已保存，意外中断后可恢复" }],
        };
      }

      case "memvid_store": {
        const { content, category = "note", tags = [], importance = 5 } = args as any;

        const putData: PutInput = {
          text: content,
          metadata: {
            category,
            tags,
            importance,
            timestamp: new Date().toISOString(),
            sessionId: currentSessionId,
          },
        };

        const frameId = await memvid.put(putData);

        if (!memoryIndex.memories[frameId]) {
          memoryIndex.memories[frameId] = {
            category,
            tags,
            importance,
            timestamp: new Date().toISOString(),
            content,
          };
          saveIndex();
        }

        return {
          content: [{ type: "text", text: `✅ 已存储 (ID: ${frameId})` }],
        };
      }

      case "memvid_search": {
        const { query, limit = 5 } = args as any;

        const findOpts: FindInput = { mode: "lex" };
        const results = await memvid.find(query, findOpts);

        if (!results.hits || results.hits.length === 0) {
          return { content: [{ type: "text", text: `没有找到: "${query}"` }] };
        }

        const limited = results.hits.slice(0, limit);
        const formatted = limited
          .map((hit: any) => {
            const frameData = memoryIndex.memories[String(hit.frame_id)];
            const meta = frameData ? ` [${frameData.category}]` : "";
            const snippet = hit.snippet ? `...\n${hit.snippet}\n...` : "";
            return `• ${hit.frame_id}${meta}\n${snippet}`;
          })
          .join("\n\n");

        return {
          content: [{ type: "text", text: `🔍 搜索结果 "${query}":\n\n${formatted}` }],
        };
      }

      case "memvid_summary": {
        const all = Object.entries(memoryIndex.memories);

        const byCategory: Record<string, number> = {};
        all.forEach(([, data]) => {
          byCategory[data.category] = (byCategory[data.category] || 0) + 1;
        });

        const categorySummary = Object.entries(byCategory)
          .map(([cat, count]) => `  ${cat}: ${count}`)
          .join("\n");

        const recent = all.slice(-3).map(([id, data]) => `  • [${id}] ${data.content.substring(0, 50)}...`).join("\n");

        let summary = `🧠 记忆摘要 (${all.length} 条)\n\n按分类:\n${categorySummary || "  无"}`;

        if (memoryIndex.currentContext) {
          const ctx = memoryIndex.currentContext;
          summary += `\n\n💾 当前上下文:\n  ${ctx.summary}`;
          if (ctx.lastProjects && ctx.lastProjects.length > 0) {
            summary += `\n  项目: ${ctx.lastProjects.join(", ")}`;
          }
        }

        if (memoryIndex.lcmState) {
          summary += `\n\n📊 LCM:\n  消息: ${memoryIndex.lcmState.messages.length}\n  摘要: ${memoryIndex.lcmState.summaries.length}`;
        }

        summary += `\n\n最近记忆:\n${recent || "  无"}`;

        return { content: [{ type: "text", text: summary }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `❌ 错误: ${errorMessage}` }],
      isError: true,
    };
  }
});

// ============================================================================
// Start Server
// ============================================================================

async function main() {
  const savedContext = await initMemvid();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP-Memvid] Server running on stdio");
  console.error("[MCP-Memvid] LCM (Lossless Context Management) enabled");

  if (savedContext) {
    console.error(`[MCP-Memvid] AUTO_RESUME:${savedContext}`);
  }
}

main().catch((error) => {
  console.error("[MCP-Memvid] Fatal error:", error);
  process.exit(1);
});
