#!/usr/bin/env node

/**
 * MCP Server for Memvid - Long-term memory for Claude Code
 *
 * Provides tools for storing, retrieving, and searching memories
 * across Claude Code sessions using Memvid as the backend.
 *
 * Auto-save and Auto-resume features for sudden interruptions.
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

// Memory file location
const MEMORY_DIR = path.join(os.homedir(), ".claude-memories");
const MEMORY_FILE = path.join(MEMORY_DIR, "claude-memories.mv2");
const MEMORY_INDEX_FILE = path.join(MEMORY_DIR, "index.json");
const CONTEXT_FILE = path.join(MEMORY_DIR, "current-context.json");

// Ensure directory exists
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// In-memory index for tracking metadata
interface MemoryIndex {
  memories: Record<string, { category: string; tags: string[]; importance: number; timestamp: string; content: string }>;
  currentContext?: {
    sessionId: string;
    timestamp: string;
    summary: string;
    topics: string[];
    lastProjects: string[];
  };
}

let memvid: Memvid | null = null;
let memoryIndex: MemoryIndex = { memories: {} };
let currentSessionId: string;

// Load or create index
function loadIndex(): void {
  if (fs.existsSync(MEMORY_INDEX_FILE)) {
    try {
      memoryIndex = JSON.parse(fs.readFileSync(MEMORY_INDEX_FILE, "utf-8"));
    } catch (e) {
      memoryIndex = { memories: {} };
    }
  }
}

// Save index
function saveIndex(): void {
  fs.writeFileSync(MEMORY_INDEX_FILE, JSON.stringify(memoryIndex, null, 2));
}

// Save current context (for auto-resume)
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

// Initialize Memvid
async function initMemvid(): Promise<string | null> {
  try {
    loadIndex();

    currentSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);

    if (fs.existsSync(MEMORY_FILE)) {
      memvid = await open(MEMORY_FILE, "basic");
      console.error(`[MCP-Memvid] Opened existing memory file: ${MEMORY_FILE}`);
    } else {
      memvid = await create(MEMORY_FILE, "basic");
      console.error(`[MCP-Memvid] Created new memory file: ${MEMORY_FILE}`);
    }

    // Return saved context for auto-resume
    if (memoryIndex.currentContext) {
      const ctx = memoryIndex.currentContext;
      console.error(`[MCP-Memvid] Found saved context from ${new Date(ctx.timestamp).toLocaleString()}`);
      return JSON.stringify(ctx);
    }
    return null;
  } catch (error) {
    console.error("[MCP-Memvid] Failed to initialize Memvid:", error);
    throw error;
  }
}

// Create server instance
const server = new Server(
  {
    name: "mcp-memvid-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Store welcome message for auto-resume
let autoResumeMessage: string | null = null;

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "memvid_auto_resume",
        description: `[AUTO] 检查并恢复之前中断的对话上下文。

服务器启动时自动调用，恢复上次的对话状态。
包含：会话摘要、讨论主题、最后处理的项目。`,
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "memvid_save_context",
        description: `保存当前对话上下文（用于意外中断后恢复）。

建议在以下情况调用：
- 完成重要任务后
- 开始新的复杂任务前
- 对话长时间暂停前

系统会自动保存：会话摘要、讨论主题、当前项目`,
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
        description: `存储一条记忆。

用于保存需要长期记住的信息。`,
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
        name: "memvid_retrieve",
        description: `按分类或标签检索记忆。`,
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "分类筛选",
              enum: ["project", "preference", "decision", "pattern", "context", "note"],
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "标签筛选",
            },
            limit: {
              type: "number",
              description: "最大返回数 (默认10)",
              default: 10,
            },
          },
        },
      },
      {
        name: "memvid_search",
        description: `搜索记忆内容。`,
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
        name: "memvid_list",
        description: "列出所有记忆",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "分类筛选",
            },
          },
        },
      },
      {
        name: "memvid_delete",
        description: "删除记忆",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "要删除的记忆ID",
            },
          },
          required: ["id"],
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

// Handle tool calls
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
          message += `🏷️ 主题: ${ctx.topics.join(", ")}\n`;
        }
        if (ctx.lastProjects && ctx.lastProjects.length > 0) {
          message += `📁 项目: ${ctx.lastProjects.join(", ")}\n`;
        }

        // Also retrieve recent memories
        const all = Object.entries(memoryIndex.memories);
        const recent = all.slice(-5);
        if (recent.length > 0) {
          message += `\n📝 最近记忆:\n`;
          recent.forEach(([id, data]) => {
            message += `  • [${data.category}] ${data.content.substring(0, 50)}...\n`;
          });
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

        // Update index
        memoryIndex.memories[frameId] = {
          category,
          tags,
          importance,
          timestamp: new Date().toISOString(),
          content,
        };
        saveIndex();

        return {
          content: [
            {
              type: "text",
              text: `✅ 已存储 (ID: ${frameId})`,
            },
          ],
        };
      }

      case "memvid_retrieve": {
        const { category, tags, limit = 10 } = args as any;

        // Filter from index
        let results = Object.entries(memoryIndex.memories);

        if (category) {
          results = results.filter(([, data]) => data.category === category);
        }
        if (tags && tags.length > 0) {
          results = results.filter(([, data]) =>
            tags.some((tag: string) => data.tags.includes(tag))
          );
        }

        // Sort by importance desc, then timestamp desc
        results.sort(([, a], [, b]) => {
          if (a.importance !== b.importance) return b.importance - a.importance;
          return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        });

        const limited = results.slice(0, limit);

        if (limited.length === 0) {
          return {
            content: [{ type: "text", text: "没有找到匹配的记忆" }],
          };
        }

        const formatted = limited
          .map(([id, data]) => {
            return `[${id}] ${data.category} ${data.tags.join(",")} (重要性: ${data.importance}/10)\n${data.content}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `📝 找到 ${limited.length} 条记忆:\n\n${formatted}`,
            },
          ],
        };
      }

      case "memvid_search": {
        const { query, limit = 5 } = args as any;

        const findOpts: FindInput = {
          mode: "lex",
        };

        const results = await memvid.find(query, findOpts);

        if (!results.hits || results.hits.length === 0) {
          return {
            content: [{ type: "text", text: `没有找到: "${query}"` }],
          };
        }

        const limited = results.hits.slice(0, limit);
        const formatted = limited
          .map((hit: any) => {
            const frameData = memoryIndex.memories[hit.frameId];
            const meta = frameData ? ` [${frameData.category}]` : "";
            const snippet = hit.snippet ? `...\n${hit.snippet}\n...` : "";
            return `• ${hit.frameId}${meta}\n${snippet}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `🔍 搜索结果 "${query}":\n\n${formatted}`,
            },
          ],
        };
      }

      case "memvid_list": {
        const { category } = args as any;

        let results = Object.entries(memoryIndex.memories);

        if (category) {
          results = results.filter(([, data]) => data.category === category);
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "还没有存储记忆" }],
          };
        }

        const formatted = results
          .map(([id, data]) => {
            const date = new Date(data.timestamp).toLocaleDateString();
            return `• [${id}] ${data.category} - ${date}\n  ${data.content.substring(0, 60)}${data.content.length > 60 ? "..." : ""}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: `📋 记忆列表 (${results.length} 条):\n\n${formatted}`,
            },
          ],
        };
      }

      case "memvid_delete": {
        const { id } = args as any;

        await memvid.remove(id);

        // Update index
        delete memoryIndex.memories[id];
        saveIndex();

        return {
          content: [
            {
              type: "text",
              text: `🗑️ 已删除: ${id}`,
            },
          ],
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

        summary += `\n\n最近记忆:\n${recent || "  无"}`;

        return {
          content: [{ type: "text", text: summary }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `❌ 错误: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const savedContext = await initMemvid();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP-Memvid] Server running on stdio");

  // Output auto-resume message for client to pick up
  if (savedContext) {
    console.error(`[MCP-Memvid] AUTO_RESUME:${savedContext}`);
  }
}

main().catch((error) => {
  console.error("[MCP-Memvid] Fatal error:", error);
  process.exit(1);
});
