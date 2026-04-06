#!/usr/bin/env node

/**
 * MCP Server for Memvid with LCM - Fully Integrated + Auto-Save
 *
 * All data (messages, summaries, memories) stored in a single .mv2 file
 * AUTO-SAVE: Context and preferences are automatically saved
 * AUTO-LOAD: Preferences are automatically loaded on startup
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
const CONTEXT_CACHE_FILE = path.join(MEMORY_DIR, "context-cache.json");

// Ensure directory exists
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// LCM Configuration
const LCM_CONFIG = {
  contextThreshold: 0.75,
  freshTailCount: 64,
  minMessagesForCompression: 20,
  leafTargetTokens: 1200,
  condensedTargetTokens: 2000,
  leafMinFanout: 8,
  condensedMinFanout: 4,
  defaultContextWindow: 200000,
};

// Auto-save configuration
const AUTO_SAVE_INTERVAL_MS = 30000; // 30 seconds

// ============================================================================
// Types
// ============================================================================

interface UserPreference {
  id: string;
  content: string;
  category: string;
  tags: string[];
  importance: number;
  timestamp: string;
}

interface ContextCache {
  currentContext?: {
    sessionId: string;
    timestamp: string;
    summary: string;
    topics: string[];
    lastProjects: string[];
    preferences?: UserPreference[];
  };
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
let autoSaveEnabled: boolean = true;
let lastAutoSaveTime: number = 0;
let activityCounter: number = 0; // Track activity for auto-save
let autoSaveTimer: NodeJS.Timeout | null = null;

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

/**
 * Trigger auto-save when activity occurs
 */
async function triggerAutoSave(): Promise<void> {
  if (!autoSaveEnabled || !memvid) return;

  activityCounter++;
  const now = Date.now();

  // Auto-save after activity or on interval
  if (now - lastAutoSaveTime > AUTO_SAVE_INTERVAL_MS) {
    await performAutoSave();
  }
}

/**
 * Perform actual auto-save
 */
async function performAutoSave(): Promise<void> {
  if (!memvid) return;

  lastAutoSaveTime = Date.now();

  // Update context timestamp
  if (contextCache.currentContext) {
    contextCache.currentContext.timestamp = new Date().toISOString();
  }
  saveContextCache();

  console.error(`[MCP-Memvid] Auto-saved context (activity: ${activityCounter})`);
}

/**
 * Load and display user preferences on startup
 */
async function loadAndDisplayPreferences(): Promise<string> {
  if (!memvid) return "";

  try {
    const results = await memvid.find("type:memory label:preference", { mode: "lex" });
    const prefs: UserPreference[] = [];

    if (results.hits) {
      for (const hit of results.hits) {
        if (hit.snippet) {
          prefs.push({
            id: hit.frame_id.toString(),
            content: hit.snippet,
            category: "preference",
            tags: [],
            importance: 5,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    if (prefs.length > 0) {
      // Save to context cache for auto-resume
      if (!contextCache.currentContext) {
        contextCache.currentContext = {
          sessionId: currentSessionId,
          timestamp: new Date().toISOString(),
          summary: "",
          topics: [],
          lastProjects: [],
          preferences: prefs,
        };
      } else {
        contextCache.currentContext.preferences = prefs;
      }
      saveContextCache();

      let output = "\n📋 用户偏好规则 (自动加载):\n\n";
      for (const pref of prefs) {
        output += `• ${pref.content}\n`;
      }
      output += "\n";

      return output;
    }
  } catch (e) {
    console.error("[MCP-Memvid] Error loading preferences:", e);
  }

  return "";
}

// ============================================================================
// In-Memory Message Tracking
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

  getLastMessages(count: number): Array<{ content: string }> {
    return this.messages.slice(-count).map(m => ({ content: m.content }));
  }
}

const sessionTracker = new SessionMessageTracker();

// ============================================================================
// LCM Core Functions
// ============================================================================

function extractTopics(messages: Array<{ content: string }>): string[] {
  const topics = new Set<string>();
  const keywords: Record<string, string[]> = {
    "配置": ["配置", "settings", "config", "电源", "power"],
    "代码": ["代码", "code", "函数", "function", "编程"],
    "系统": ["系统", "system", "linux", "命令", "command"],
    "网络": ["网络", "network", "api", "http", "请求"],
    "文件": ["文件", "file", "目录", "folder", "path"],
  };

  const text = messages.map(m => m.content.toLowerCase()).join(" ");

  for (const [topic, words] of Object.entries(keywords)) {
    if (words.some(w => text.includes(w.toLowerCase()))) {
      topics.add(topic);
    }
  }

  return Array.from(topics);
}

function createSummary(messages: Array<{ id: string; role: string; content: string; timestamp: string }>): string {
  if (messages.length === 0) return "";

  const topics = extractTopics(messages);
  let summary = `## 对话摘要 (${new Date().toLocaleString()})\n\n`;
  summary += `**消息数**: ${messages.length}\n`;

  if (topics.length > 0) {
    summary += `**主题**: ${topics.join(", ")}\n`;
  }

  // Add key points from last few messages
  const recent = messages.slice(-5);
  for (const msg of recent) {
    const point = msg.content.substring(0, 80).replace(/\n/g, " ");
    if (point) summary += `- ${point}...\n`;
  }

  return summary;
}

async function performCompaction(force: boolean = false): Promise<{ summaryId: string; compressedCount: number; summary: string } | null> {
  const allMessages = sessionTracker.getAll();
  const uncompressed = sessionTracker.getUncompressed();

  const safeCount = Math.min(LCM_CONFIG.freshTailCount, Math.floor(uncompressed.length / 2));
  const toCompress = uncompressed.slice(0, Math.max(0, uncompressed.length - safeCount));

  if (toCompress.length < LCM_CONFIG.leafMinFanout && !force) {
    return null;
  }

  const summaryContent = createSummary(toCompress);
  const sourceIds = toCompress.map(m => m.id);
  const topics = extractTopics(toCompress);

  const summaryId = generateId();
  await memvid!.put({
    text: summaryContent,
    metadata: {
      type: "summary",
      summaryId,
      sourceIds,
      depth: 1,
      topics,
      timestamp: new Date().toISOString(),
      messageCount: sourceIds.length,
    },
    labels: ["lcm", "summary", "leaf"],
  });

  sessionTracker.markCompressed(sourceIds);
  contextCache.summaryCount = (contextCache.summaryCount || 0) + 1;
  saveContextCache();

  return {
    summaryId,
    compressedCount: sourceIds.length,
    summary: summaryContent,
  };
}

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

      const summaryResults = await memvid!.find("type:summary", { mode: "lex" });
      contextCache.summaryCount = summaryResults.hits?.length || 0;
    } else {
      memvid = await create(MEMORY_FILE, "basic");
      console.error(`[MCP-Memvid] Created: ${MEMORY_FILE}`);
    }

    // Load and display preferences
    const prefsOutput = await loadAndDisplayPreferences();

    if (contextCache.currentContext) {
      const ctx = contextCache.currentContext;
      let resumeInfo = `🔄 恢复上次会话 (${Math.floor((Date.now() - new Date(ctx.timestamp).getTime()) / 60000)}分钟前)\n\n`;
      resumeInfo += `📋 摘要: ${ctx.summary}\n`;
      if (ctx.topics && ctx.topics.length > 0) resumeInfo += `🏷️ 主题: ${ctx.topics.join(", ")}\n`;
      resumeInfo += prefsOutput;
      return resumeInfo;
    }

    // New session but still show preferences if any
    if (prefsOutput) {
      return "🆕 新会话\n\n" + prefsOutput;
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
        description: `[LCM] 查看当前上下文状态`,
        inputSchema: {
          type: "object",
          properties: {
            maxTokens: { type: "number", description: "上下文窗口大小 (默认 200000)", default: 200000 },
          },
        },
      },
      {
        name: "lcm_compact",
        description: `[LCM] 执行上下文压缩`,
        inputSchema: {
          type: "object",
          properties: {
            force: { type: "boolean", description: "强制压缩", default: false },
          },
        },
      },
      {
        name: "lcm_list_summaries",
        description: `[LCM] 列出所有摘要节点`,
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "lcm_search",
        description: `[LCM] 在消息和摘要中搜索`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索查询" },
          },
          required: ["query"],
        },
      },
      {
        name: "memvid_auto_resume",
        description: `[AUTO] 检查并恢复之前中断的对话上下文`,
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "memvid_save_context",
        description: `保存当前对话上下文（用于意外中断后恢复）`,
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "当前对话摘要（1-2句话）" },
            topics: { type: "array", items: { type: "string" }, description: "当前讨论的主题列表" },
            projects: { type: "array", items: { type: "string" }, description: "当前处理的项目路径或名称" },
          },
          required: ["summary"],
        },
      },
      {
        name: "memvid_quick_save",
        description: `[AUTO] 快速保存当前对话上下文（自动生成摘要）`,
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "memvid_store",
        description: `存储一条长期记忆（如用户偏好、项目信息、技术决策等）`,
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "记忆内容" },
            category: { type: "string", description: "分类", enum: ["project", "preference", "decision", "pattern", "context", "note"] },
            tags: { type: "array", items: { type: "string" }, description: "标签" },
            importance: { type: "number", description: "重要性 (1-10, 默认5)", minimum: 1, maximum: 10 },
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
            query: { type: "string", description: "搜索查询" },
            limit: { type: "number", description: "最大结果数 (默认5)", default: 5 },
          },
          required: ["query"],
        },
      },
      {
        name: "memvid_summary",
        description: "获取记忆和上下文摘要",
        inputSchema: { type: "object", properties: {} },
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

  // Trigger auto-save on any tool call
  triggerAutoSave().catch(e => console.error("[MCP-Memvid] Auto-save error:", e));

  try {
    let result: any;

    switch (name) {
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
          output += `⚠️  建议执行压缩\n   可压缩约 ${canCompress} 条消息\n   运行: lcm_compact()`;
        } else {
          output += `✅ 无需压缩`;
        }

        result = { content: [{ type: "text", text: output }] };
        break;
      }

      case "lcm_compact": {
        const { force = false } = args as any;
        const compactResult = await performCompaction(force);

        if (!compactResult) {
          result = { content: [{ type: "text", text: "ℹ️  没有足够的消息需要压缩" }] };
        } else {
          let output = `✅ 压缩完成\n\n`;
          output += `📦 摘要ID: ${compactResult.summaryId}\n`;
          output += `📝 压缩消息: ${compactResult.compressedCount} 条\n`;
          output += `🔤 摘要 tokens: ${estimateTokens(compactResult.summary)}\n\n`;
          output += `💾 摘要已保存到 Memvid`;
          result = { content: [{ type: "text", text: output }] };
        }
        break;
      }

      case "lcm_list_summaries": {
        const summaryCount = contextCache.summaryCount || 0;
        if (summaryCount === 0) {
          result = { content: [{ type: "text", text: "还没有摘要" }] };
        } else {
          const results = await memvid.find("type:summary", { mode: "lex" });
          let output = `📋 摘要列表 (${summaryCount} 个)\n\n`;

          if (results.hits && results.hits.length > 0) {
            for (const hit of results.hits.slice(0, 10)) {
              output += `• [${hit.frame_id}]\n`;
              output += `  ${hit.title || "无标题"}\n`;
              output += `  ${hit.snippet?.substring(0, 80)}...\n\n`;
            }
          }

          if (summaryCount > 10) {
            output += `\n... 还有 ${summaryCount - 10} 个摘要`;
          }
          result = { content: [{ type: "text", text: output }] };
        }
        break;
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
        result = { content: [{ type: "text", text: output }] };
        break;
      }

      case "memvid_auto_resume": {
        if (!contextCache.currentContext) {
          result = {
            content: [{ type: "text", text: "✅ 没有保存的上下文，这是一个新会话。" }],
          };
        } else {
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

          // Show preferences if available
          if (ctx.preferences && ctx.preferences.length > 0) {
            output += `\n📋 用户偏好:\n`;
            for (const pref of ctx.preferences) {
              output += `• ${pref.content}\n`;
            }
          }

          const status = getStatus();
          output += `\n📊 当前状态:\n  消息: ${status.messageCount}\n  摘要: ${status.summaryCount}`;

          result = { content: [{ type: "text", text: output }] };
        }
        break;
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

        result = {
          content: [{ type: "text", text: "✅ 上下文已保存，意外中断后可恢复" }],
        };
        break;
      }

      case "memvid_quick_save": {
        const messages = sessionTracker.getAll().slice(-10);
        let autoSummary = "当前对话";

        if (messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          autoSummary = lastMsg.content.substring(0, 100).replace(/\n/g, " ");
          if (lastMsg.content.length > 100) autoSummary += "...";
        }

        const autoTopics = extractTopics(messages.map(m => ({ content: m.content })));

        contextCache.currentContext = {
          sessionId: currentSessionId,
          timestamp: new Date().toISOString(),
          summary: autoSummary || "进行中的对话",
          topics: autoTopics,
          lastProjects: [],
        };
        saveContextCache();

        await memvid.put({
          text: `Context: ${autoSummary}`,
          metadata: {
            type: "context-snapshot",
            timestamp: new Date().toISOString(),
            topics: autoTopics,
            autoGenerated: true,
          },
          labels: ["context", "current", "auto"],
        });

        result = {
          content: [{ type: "text", text: `✅ 已自动保存上下文\n\n📋 摘要: ${autoSummary}\n🏷️ 主题: ${autoTopics.join(", ") || "无"}` }],
        };
        break;
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

        // If storing a preference, reload and cache it
        if (category === "preference") {
          const prefs = await loadAndDisplayPreferences();
          console.error("[MCP-Memvid] Preference saved and cached");
        }

        result = {
          content: [{ type: "text", text: `✅ 已存储到 Memvid` }],
        };
        break;
      }

      case "memvid_search": {
        const { query, limit = 5 } = args as any;

        const results = await memvid.find(`type:memory ${query}`, { mode: "lex" });

        if (!results.hits || results.hits.length === 0) {
          result = { content: [{ type: "text", text: `没有找到: "${query}"` }] };
        } else {
          let output = `🔍 搜索结果 "${query}":\n\n`;

          for (const hit of results.hits.slice(0, limit)) {
            output += `• [${hit.frame_id}]\n`;
            if (hit.snippet) {
              output += `  ${hit.snippet}\n`;
            }
            output += `\n`;
          }
          result = { content: [{ type: "text", text: output }] };
        }
        break;
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

        result = { content: [{ type: "text", text: output }] };
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return result;
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
  console.error("[MCP-Memvid] Auto-save ENABLED - Context saved every 30s");
  console.error("[MCP-Memvid] Auto-load ENABLED - Preferences loaded on startup");

  if (savedContext) {
    console.error(`[MCP-Memvid] AUTO_RESUME:${savedContext}`);
  }

  // Start auto-save interval
  autoSaveTimer = setInterval(async () => {
    await performAutoSave();
  }, AUTO_SAVE_INTERVAL_MS);
}

main().catch((error) => {
  console.error("[MCP-Memvid] Fatal error:", error);
  process.exit(1);
});

// Cleanup on exit
process.on("SIGINT", () => {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  performAutoSave().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  if (autoSaveTimer) clearInterval(autoSaveTimer);
  performAutoSave().then(() => process.exit(0));
});
