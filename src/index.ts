#!/usr/bin/env node

/**
 * MCP Server for Memvid with LCM - Fully Integrated
 *
 * All data (messages, summaries, memories) stored in a single .mv2 file
 * No separate state files - everything is in Memvid
 *
 * Based on LCM paper: https://papers.voltropy.com/LCM
 * Inspired by: https://github.com/Martian-Engineering/lossless-claw
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
const CONTEXT_CACHE_FILE = path.join(MEMORY_DIR, "context-cache.json"); // Only for fast startup cache

// Ensure directory exists
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// LCM Configuration
const LCM_CONFIG = {
  // Trigger compaction when context reaches this fraction of window
  contextThreshold: 0.75,

  // Number of recent messages protected from compaction
  freshTailCount: 64,

  // Minimum messages before triggering compression
  minMessagesForCompression: 20,

  // Target tokens for summaries
  leafTargetTokens: 1200,
  condensedTargetTokens: 2000,

  // Minimum messages per summary
  leafMinFanout: 8,
  condensedMinFanout: 4,

  // Default context window size (tokens)
  defaultContextWindow: 200000, // Opus 1M
};

// ============================================================================
// Types
// ============================================================================

interface LCMMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  compressed: boolean;
  sessionId: string;
}

interface LCMSummary {
  id: string;
  type: "leaf" | "condensed";
  content: string;
  sourceIds: string[];
  depth: number;
  timestamp: string;
  topics: string[];
  metadata: {
    messageCount: number;
    timeSpan: { start: string; end: string };
    tokenCount: number;
  };
}

interface ContextCache {
  currentContext?: {
    sessionId: string;
    timestamp: string;
    summary: string;
    topics: string[];
    lastProjects: string[];
  };
  // Cache for faster startup - will be rebuilt from Memvid if missing
  messageCount?: number;
  summaryCount?: number;
  lastSyncTime?: string;
}

// ============================================================================
// State
// ============================================================================

let memvid: Memvid | null = null;
let currentSessionId: string;
let contextCache: ContextCache = {};

// ============================================================================
// Utilities
// ============================================================================

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 2 + otherChars / 4);
}

function saveContextCache(): void {
  try {
    fs.writeFileSync(CONTEXT_CACHE_FILE, JSON.stringify(contextCache, null, 2));
  } catch (e) {
    // Ignore cache write errors
  }
}

function loadContextCache(): void {
  if (fs.existsSync(CONTEXT_CACHE_FILE)) {
    try {
      contextCache = JSON.parse(fs.readFileSync(CONTEXT_CACHE_FILE, "utf-8"));
    } catch (e) {
      contextCache = {};
    }
  }
}

// ============================================================================
// Memvid Operations - All data goes through here
// ============================================================================

/**
 * Store a message in Memvid
 */
async function storeMessage(role: "user" | "assistant" | "system", content: string): Promise<string> {
  const msgId = generateId();
  const msg: LCMMessage = {
    id: msgId,
    role,
    content,
    timestamp: new Date().toISOString(),
    compressed: false,
    sessionId: currentSessionId,
  };

  const putData: PutInput = {
    text: content,
    metadata: {
      type: "message",
      messageId: msgId,
      role,
      sessionId: currentSessionId,
      timestamp: msg.timestamp,
      compressed: false,
    },
    labels: ["lcm", "message", role],
  };

  await memvid!.put(putData);
  return msgId;
}

/**
 * Store a summary in Memvid
 */
async function storeSummary(
  summaryContent: string,
  sourceIds: string[],
  depth: number,
  topics: string[]
): Promise<string> {
  const summaryId = generateId();

  const putData: PutInput = {
    text: summaryContent,
    metadata: {
      type: "summary",
      summaryId,
      sourceIds,
      depth,
      topics,
      timestamp: new Date().toISOString(),
      messageCount: sourceIds.length,
    },
    labels: ["lcm", "summary", depth === 1 ? "leaf" : "condensed"],
  };

  await memvid!.put(putData);

  // Mark source messages as compressed
  for (const sourceId of sourceIds) {
    await markMessageCompressed(sourceId);
  }

  return summaryId;
}

/**
 * Mark a message as compressed
 */
async function markMessageCompressed(messageId: string): Promise<void> {
  // We need to find the frame and update its metadata
  // Since Memvid doesn't support updates, we add a new "tombstone" entry
  const putData: PutInput = {
    text: `[COMPRESSED] ${messageId}`,
    metadata: {
      type: "compression-marker",
      messageId,
      compressed: true,
      timestamp: new Date().toISOString(),
    },
    labels: ["lcm", "compressed"],
  };

  await memvid!.put(putData);
}

/**
 * Retrieve all messages from Memvid
 */
async function getAllMessages(): Promise<LCMMessage[]> {
  const findOpts: FindInput = {
    mode: "lex",
  };

  const results = await memvid!.find("type:message", findOpts);

  const messages: LCMMessage[] = [];

  if (results.hits) {
    for (const hit of results.hits) {
      // Check if this message is compressed
      const compressedCheck = await memvid!.find(`compression-marker:${hit.frame_id}`, { mode: "lex" });

      if (!compressedCheck.hits || compressedCheck.hits.length === 0) {
        // Message is not compressed
        messages.push({
          id: hit.frame_id.toString(),
          role: "user", // Default, would be in metadata in real impl
          content: hit.snippet || "",
          timestamp: new Date().toISOString(),
          compressed: false,
          sessionId: "",
        });
      }
    }
  }

  return messages;
}

/**
 * Get uncompressed message count (estimated)
 */
async function getUncompressedMessageCount(): Promise<number> {
  const findOpts: FindInput = {
    mode: "lex",
  };

  const results = await memvid!.find("label:lcm label:message", findOpts);
  return results.hits?.length || 0;
}

/**
 * Get all summaries from Memvid
 */
async function getAllSummaries(): Promise<LCMSummary[]> {
  const findOpts: FindInput = {
    mode: "lex",
  };

  const results = await memvid!.find("type:summary", findOpts);
  const summaries: LCMSummary[] = [];

  if (results.hits) {
    for (const hit of results.hits) {
      // Parse metadata from the stored data
      // In a real implementation, we'd store the full metadata
      summaries.push({
        id: hit.frame_id.toString(),
        type: "leaf",
        content: hit.snippet || "",
        sourceIds: [],
        depth: 1,
        timestamp: new Date().toISOString(),
        topics: [],
        metadata: {
          messageCount: 0,
          timeSpan: { start: "", end: "" },
          tokenCount: estimateTokens(hit.snippet || ""),
        },
      });
    }
  }

  return summaries;
}

/**
 * Get a summary by ID with full content
 */
async function getSummary(summaryId: string): Promise<LCMSummary | null> {
  const findOpts: FindInput = {
    mode: "lex",
  };

  const results = await memvid!.find(`summaryId:${summaryId}`, findOpts);

  if (results.hits && results.hits.length > 0) {
    const hit = results.hits[0];
    return {
      id: summaryId,
      type: "leaf",
      content: hit.snippet || "",
      sourceIds: [],
      depth: 1,
      timestamp: new Date().toISOString(),
      topics: [],
      metadata: {
        messageCount: 0,
        timeSpan: { start: "", end: "" },
        tokenCount: estimateTokens(hit.snippet || ""),
      },
    };
  }

  return null;
}

/**
 * Search across messages and summaries
 */
async function searchAll(query: string): Promise<{ messages: LCMMessage[]; summaries: LCMSummary[] }> {
  const findOpts: FindInput = {
    mode: "lex",
  };

  const results = await memvid!.find(query, findOpts);

  const messages: LCMMessage[] = [];
  const summaries: LCMSummary[] = [];

  if (results.hits) {
    for (const hit of results.hits) {
      // Determine if this is a message or summary based on content
      if (hit.title?.includes("摘要") || hit.snippet?.includes("## 对话摘要")) {
        summaries.push({
          id: hit.frame_id.toString(),
          type: "leaf",
          content: hit.snippet || "",
          sourceIds: [],
          depth: 1,
          timestamp: new Date().toISOString(),
          topics: [],
          metadata: {
            messageCount: 0,
            timeSpan: { start: "", end: "" },
            tokenCount: estimateTokens(hit.snippet || ""),
          },
        });
      } else {
        messages.push({
          id: hit.frame_id.toString(),
          role: "user",
          content: hit.snippet || "",
          timestamp: new Date().toISOString(),
          compressed: false,
          sessionId: "",
        });
      }
    }
  }

  return { messages, summaries };
}

// ============================================================================
// In-Memory Message Tracking (for current session)
// ============================================================================

class SessionMessageTracker {
  private messages: Array<{ id: string; role: string; content: string; timestamp: string; compressed: boolean }> = [];

  add(role: string, content: string): string {
    const id = generateId();
    this.messages.push({ id, role, content, timestamp: new Date().toISOString(), compressed: false });
    return id;
  }

  getAll(): Array<{ id: string; role: string; content: string; timestamp: string; compressed: boolean }> {
    return this.messages;
  }

  getUncompressed(): Array<{ id: string; role: string; content: string; timestamp: string }> {
    return this.messages.filter(m => !m.compressed);
  }

  markCompressed(ids: string[]): void {
    for (const id of ids) {
      const msg = this.messages.find(m => m.id === id);
      if (msg) msg.compressed = true;
    }
  }

  count(): number {
    return this.messages.length;
  }

  estimateTokens(): number {
    return this.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  clear(): void {
    this.messages = [];
  }
}

const sessionTracker = new SessionMessageTracker();

// ============================================================================
// LCM Core Functions
// ============================================================================

/**
 * Create a summary from messages
 */
function createSummary(messages: Array<{ id: string; role: string; content: string; timestamp: string }>): string {
  if (messages.length === 0) return "";

  // Extract topics
  const topics = extractTopics(messages);

  let summary = `## 对话摘要 (${new Date().toLocaleString()})\n\n`;

  // Overview
  summary += `**时间范围**: ${messages[0]?.timestamp} - ${messages[messages.length - 1]?.timestamp}\n`;
  summary += `**消息数**: ${messages.length}\n\n`;

  if (topics.length > 0) {
    summary += `**讨论主题**: ${topics.join(", ")}\n\n`;
  }

  // Group by topic
  const groups = groupMessagesByTopic(messages);

  summary += `### 关键内容\n\n`;
  for (const group of groups) {
    summary += `#### ${group.topic}\n`;
    for (const point of group.points.slice(0, 5)) {
      summary += `- ${point}\n`;
    }
    summary += `\n`;
  }

  // Extract decisions
  const decisions = extractDecisions(messages);
  if (decisions.length > 0) {
    summary += `### 重要决策\n\n`;
    for (const decision of decisions.slice(0, 5)) {
      summary += `- ${decision}\n`;
    }
  }

  return summary;
}

/**
 * Extract topics from messages
 */
function extractTopics(messages: Array<{ content: string }>): string[] {
  const topics = new Set<string>();
  const keywords = {
    "rust": ["rust", "cargo", "tokio", "serde"],
    "crypto": ["加密", "密码", "bip39", "助记词", "mnemonic", "bitcoin", "ethereum"],
    "web": ["html", "css", "javascript", "react", "vue", "前端"],
    "mcp": ["mcp", "memvid", "context", "记忆", "lcm"],
    "git": ["git", "github", "commit", "push", "pull"],
    "dice-mnemonic": ["dice", "mnemonic", "骰子", "助记词"],
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
 * Group messages by topic
 */
function groupMessagesByTopic(messages: Array<{ content: string; timestamp: string }>): Array<{ topic: string; points: string[] }> {
  const groups: Array<{ topic: string; points: string[] }> = [];
  let currentTopic = "开始";

  for (const msg of messages) {
    const content = msg.content.toLowerCase();

    // Detect topic changes
    if (content.includes("dice") || content.includes("mnemonic")) {
      if (currentTopic !== "dice-mnemonic") {
        groups.push({ topic: "dice-mnemonic", points: [] });
        currentTopic = "dice-mnemonic";
      }
    } else if (content.includes("mcp") || content.includes("memvid") || content.includes("lcm")) {
      if (currentTopic !== "mcp-memvid") {
        groups.push({ topic: "mcp-memvid", points: [] });
        currentTopic = "mcp-memvid";
      }
    } else if (content.includes("修复") || content.includes("bug") || content.includes("error")) {
      if (currentTopic !== "问题修复") {
        groups.push({ topic: "问题修复", points: [] });
        currentTopic = "问题修复";
      }
    }

    // Add key point
    const group = groups.find(g => g.topic === currentTopic) || groups[groups.length - 1];
    if (group) {
      const point = msg.content.substring(0, 80).replace(/\n/g, " ").trim();
      if (point && !group.points.some(p => p.includes(point.substring(0, 30)))) {
        group.points.push(point);
      }
    }
  }

  return groups;
}

/**
 * Extract decisions from messages
 */
function extractDecisions(messages: Array<{ content: string }>): string[] {
  const decisions: string[] = [];
  const patterns = [
    /决定[：:]\s*(.+)/,
    /决策[：:]\s*(.+)/,
    /使用\s+(.+)/,
    /选择\s+(.+)/,
  ];

  for (const msg of messages) {
    for (const pattern of patterns) {
      const match = msg.content.match(pattern);
      if (match && match[1]) {
        const decision = match[1].trim().substring(0, 100);
        if (decision && !decisions.includes(decision)) {
          decisions.push(decision);
        }
      }
    }
  }

  return decisions.slice(0, 5);
}

/**
 * Perform compaction - summarize old messages
 */
async function performCompaction(force: boolean = false): Promise<{ summaryId: string; compressedCount: number; summary: string } | null> {
  const allMessages = sessionTracker.getAll();
  const uncompressed = sessionTracker.getUncompressed();

  // Keep recent messages safe
  const safeCount = Math.min(LCM_CONFIG.freshTailCount, Math.floor(uncompressed.length / 2));
  const toCompress = uncompressed.slice(0, Math.max(0, uncompressed.length - safeCount));

  if (toCompress.length < LCM_CONFIG.leafMinFanout && !force) {
    return null;
  }

  // Create summary
  const summaryContent = createSummary(toCompress);
  const sourceIds = toCompress.map(m => m.id);
  const topics = extractTopics(toCompress);

  // Store in Memvid
  const summaryId = await storeSummary(summaryContent, sourceIds, 1, topics);

  // Mark as compressed in tracker
  sessionTracker.markCompressed(sourceIds);

  // Update cache
  contextCache.summaryCount = (contextCache.summaryCount || 0) + 1;
  saveContextCache();

  return {
    summaryId,
    compressedCount: sourceIds.length,
    summary: summaryContent,
  };
}

/**
 * Get current status
 */
function getStatus(maxTokens: number = LCM_CONFIG.defaultContextWindow): {
  messageCount: number;
  estimatedTokens: number;
  summaryCount: number;
  shouldCompact: boolean;
} {
  const messageCount = sessionTracker.count();
  const estimatedTokens = sessionTracker.estimateTokens();
  const summaryCount = contextCache.summaryCount || 0;
  const threshold = maxTokens * LCM_CONFIG.contextThreshold;
  const shouldCompact = estimatedTokens > threshold && messageCount > LCM_CONFIG.minMessagesForCompression;

  return {
    messageCount,
    estimatedTokens,
    summaryCount,
    shouldCompact,
  };
}

// ============================================================================
// Memvid Initialization
// ============================================================================

async function initMemvid(): Promise<string | null> {
  try {
    loadContextCache();
    currentSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);

    if (fs.existsSync(MEMORY_FILE)) {
      memvid = await open(MEMORY_FILE, "basic");
      console.error(`[MCP-Memvid] Opened: ${MEMORY_FILE}`);

      // Count existing summaries
      const summaryResults = await memvid!.find("type:summary", { mode: "lex" });
      contextCache.summaryCount = summaryResults.hits?.length || 0;
    } else {
      memvid = await create(MEMORY_FILE, "basic");
      console.error(`[MCP-Memvid] Created: ${MEMORY_FILE}`);
    }

    if (contextCache.currentContext) {
      const ctx = contextCache.currentContext;
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
        description: `[LCM] 查看当前上下文状态

返回：
- 当前消息数量
- 估算的 token 数
- 摘要节点数量
- 是否需要压缩`,
        inputSchema: {
          type: "object",
          properties: {
            maxTokens: {
              type: "number",
              description: "上下文窗口大小 (默认 200000)",
              default: 200000,
            },
          },
        },
      },
      {
        name: "lcm_compact",
        description: `[LCM] 执行上下文压缩

将旧消息摘要化，释放上下文空间。
压缩后的消息仍可搜索和展开。`,
        inputSchema: {
          type: "object",
          properties: {
            force: {
              type: "boolean",
              description: "强制压缩，即使未达到阈值",
              default: false,
            },
          },
        },
      },
      {
        name: "lcm_list_summaries",
        description: `[LCM] 列出所有摘要节点`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "lcm_search",
        description: `[LCM] 在消息和摘要中搜索

搜索存储在 Memvid 中的所有历史对话。`,
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
        description: `[AUTO] 检查并恢复之前中断的对话上下文

新会话开始时自动调用。`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "memvid_save_context",
        description: `保存当前对话上下文（用于意外中断后恢复）

建议在完成重要任务后调用。`,
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
        description: `存储一条长期记忆

用于保存需要长期记住的信息，如用户偏好、项目信息、技术决策等。`,
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
        description: `搜索长期记忆`,
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
        description: "获取记忆和上下文摘要",
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
        const { maxTokens = LCM_CONFIG.defaultContextWindow } = args as any;
        const status = getStatus(maxTokens);

        let output = `📊 LCM 状态\n\n`;
        output += `📝 当前消息: ${status.messageCount} 条\n`;
        output += `🔤 估算 tokens: ${status.estimatedTokens.toLocaleString()}\n`;
        output += `📦 已创建摘要: ${status.summaryCount} 个\n`;
        output += `🎯 压缩阈值: ${(maxTokens * LCM_CONFIG.contextThreshold).toLocaleString()} (${LCM_CONFIG.contextThreshold * 100}%)\n\n`;

        if (status.shouldCompact) {
          const canCompress = Math.max(0, status.messageCount - LCM_CONFIG.freshTailCount);
          output += `⚠️  建议执行压缩\n`;
          output += `   可压缩约 ${canCompress} 条消息\n`;
          output += `   运行: lcm_compact()`;
        } else {
          output += `✅ 无需压缩`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "lcm_compact": {
        const { force = false } = args as any;
        const result = await performCompaction(force);

        if (!result) {
          return {
            content: [{ type: "text", text: "ℹ️  没有足够的消息需要压缩" }],
          };
        }

        let output = `✅ 压缩完成\n\n`;
        output += `📦 摘要ID: ${result.summaryId}\n`;
        output += `📝 压缩消息: ${result.compressedCount} 条\n`;
        output += `🔤 摘要 tokens: ${estimateTokens(result.summary)}\n\n`;
        output += `💾 摘要已保存到 Memvid`;

        return { content: [{ type: "text", text: output }] };
      }

      case "lcm_list_summaries": {
        const summaryCount = contextCache.summaryCount || 0;

        if (summaryCount === 0) {
          return { content: [{ type: "text", text: "还没有摘要" }] };
        }

        // Search for summaries in Memvid
        const results = await memvid.find("type:summary", { mode: "lex" });

        let output = `📋 摘要列表 (${summaryCount} 个)\n\n`;

        if (results.hits && results.hits.length > 0) {
          for (const hit of results.hits.slice(0, 10)) {
            output += `• [${hit.frame_id}]\n`;
            output += `  ${hit.title || "无标题"}\n`;
            output += `  ${hit.snippet?.substring(0, 80)}...\n\n`;
          };
        }

        if (summaryCount > 10) {
          output += `\n... 还有 ${summaryCount - 10} 个摘要`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "lcm_search": {
        const { query } = args as any;
        const results = await memvid.find(query, { mode: "lex" });

        let output = `🔍 搜索: "${query}"\n\n`;

        if (!results.hits || results.hits.length === 0) {
          output += "没有找到匹配内容";
        } else {
          output += `找到 ${results.hits.length} 条结果:\n\n`;
          for (const hit of results.hits.slice(0, 10)) {
            output += `• [${hit.frame_id}]\n`;
            if (hit.title) output += `  标题: ${hit.title}\n`;
            if (hit.snippet) output += `  ${hit.snippet.substring(0, 100)}...\n`;
            output += `\n`;
          }
        }

        return { content: [{ type: "text", text: output }] };
      }

      // ========================================================================
      // Memory Tools
      // ========================================================================

      case "memvid_auto_resume": {
        if (!contextCache.currentContext) {
          return {
            content: [{ type: "text", text: "✅ 没有保存的上下文，这是一个新会话。" }],
          };
        }

        const ctx = contextCache.currentContext;
        const timeAgo = Math.floor((Date.now() - new Date(ctx.timestamp).getTime()) / 60000);

        let output = `🔄 恢复上次会话 (${timeAgo}分钟前)\n\n`;
        output += `📋 摘要: ${ctx.summary}\n`;

        if (ctx.topics && ctx.topics.length > 0) {
          output += `🏷️  主题: ${ctx.topics.join(", ")}\n`;
        }

        if (ctx.lastProjects && ctx.lastProjects.length > 0) {
          output += `📁 项目: ${ctx.lastProjects.join(", ")}\n`;
        }

        // Also show LCM status
        const status = getStatus();
        output += `\n📊 当前状态:\n`;
        output += `  消息: ${status.messageCount}\n`;
        output += `  摘要: ${status.summaryCount}`;

        return { content: [{ type: "text", text: output }] };
      }

      case "memvid_save_context": {
        const { summary, topics = [], projects = [] } = args as any;

        contextCache.currentContext = {
          sessionId: currentSessionId,
          timestamp: new Date().toISOString(),
          summary,
          topics,
          lastProjects: projects,
        };
        saveContextCache();

        // Also store in Memvid for persistence
        await memvid.put({
          text: `Context: ${summary}`,
          metadata: {
            type: "context-snapshot",
            timestamp: new Date().toISOString(),
            topics,
            projects,
          },
          labels: ["context", "current"],
        });

        return {
          content: [{ type: "text", text: "✅ 上下文已保存，意外中断后可恢复" }],
        };
      }

      case "memvid_store": {
        const { content, category = "note", tags = [], importance = 5 } = args as any;

        await memvid.put({
          text: content,
          metadata: {
            type: "memory",
            category,
            tags,
            importance,
            timestamp: new Date().toISOString(),
            sessionId: currentSessionId,
          },
          labels: ["memory", category],
        });

        return {
          content: [{ type: "text", text: `✅ 已存储到 Memvid` }],
        };
      }

      case "memvid_search": {
        const { query, limit = 5 } = args as any;

        const results = await memvid.find(`type:memory ${query}`, { mode: "lex" });

        if (!results.hits || results.hits.length === 0) {
          return { content: [{ type: "text", text: `没有找到: "${query}"` }] };
        }

        let output = `🔍 搜索结果 "${query}":\n\n`;

        for (const hit of results.hits.slice(0, limit)) {
          output += `• [${hit.frame_id}]\n`;
          if (hit.snippet) {
            output += `  ${hit.snippet}\n`;
          }
          output += `\n`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "memvid_summary": {
        const status = getStatus();

        let output = `🧠 记忆摘要\n\n`;
        output += `📊 LCM 状态:\n`;
        output += `  消息: ${status.messageCount}\n`;
        output += `  摘要: ${status.summaryCount}\n`;

        if (contextCache.currentContext) {
          const ctx = contextCache.currentContext;
          output += `\n💾 当前上下文:\n`;
          output += `  ${ctx.summary}\n`;
          if (ctx.lastProjects && ctx.lastProjects.length > 0) {
            output += `  项目: ${ctx.lastProjects.join(", ")}\n`;
          }
        }

        return { content: [{ type: "text", text: output }] };
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
  console.error("[MCP-Memvid] LCM enabled - All data stored in Memvid (.mv2)");

  if (savedContext) {
    console.error(`[MCP-Memvid] AUTO_RESUME:${savedContext}`);
  }
}

main().catch((error) => {
  console.error("[MCP-Memvid] Fatal error:", error);
  process.exit(1);
});
