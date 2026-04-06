#!/usr/bin/env node

/**
 * MCP Server for Memvid - Long-term memory for Claude Code
 *
 * Provides tools for storing, retrieving, and searching memories
 * across Claude Code sessions using Memvid as the backend.
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

// Ensure directory exists
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

// In-memory index for tracking metadata
interface MemoryIndex {
  memories: Record<string, { category: string; tags: string[]; importance: number; timestamp: string; content: string }>;
}

let memvid: Memvid | null = null;
let memoryIndex: MemoryIndex = { memories: {} };

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

// Initialize Memvid
async function initMemvid(): Promise<void> {
  try {
    loadIndex();

    if (fs.existsSync(MEMORY_FILE)) {
      memvid = await open(MEMORY_FILE, "basic");
      console.error(`[MCP-Memvid] Opened existing memory file: ${MEMORY_FILE}`);
    } else {
      memvid = await create(MEMORY_FILE, "basic");
      console.error(`[MCP-Memvid] Created new memory file: ${MEMORY_FILE}`);
    }
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

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "memvid_store",
        description: `Store a memory with content and optional metadata.

The memory will be persisted across Claude Code sessions and can be retrieved later.

Examples:
- Store code context: "User prefers Rust for systems programming"
- Store project info: "Project dice-mnemonic is a BIP39 mnemonic generator"
- Store decisions: "Decided to use frozenEntropy to ensure mnemonic consistency"
- Store patterns: "User likes concise responses without summaries"`,
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The memory content to store",
            },
            category: {
              type: "string",
              description: "Optional category",
              enum: ["project", "preference", "decision", "pattern", "context", "note"],
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Optional tags for better retrieval",
            },
            importance: {
              type: "number",
              description: "Importance score (1-10, default 5)",
              minimum: 1,
              maximum: 10,
            },
          },
          required: ["content"],
        },
      },
      {
        name: "memvid_retrieve",
        description: `Retrieve memories by category, tags, or recent memories.

Use this to:
- Load context when starting a new session
- Recall user preferences
- Find past decisions or patterns`,
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "Filter by category",
              enum: ["project", "preference", "decision", "pattern", "context", "note"],
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Filter by tags",
            },
            limit: {
              type: "number",
              description: "Maximum number of memories to return (default 10)",
              default: 10,
            },
          },
        },
      },
      {
        name: "memvid_search",
        description: `Search for memories using natural language or keywords.

Use this to find relevant memories by content.
Examples:
- "what did user say about Rust"
- "decisions about error handling"
- "preferences for code style"`,
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
            limit: {
              type: "number",
              description: "Maximum results (default 5)",
              default: 5,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "memvid_list",
        description: "List all stored memories with metadata",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "Filter by category",
            },
          },
        },
      },
      {
        name: "memvid_delete",
        description: "Delete a memory by ID",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Memory ID to delete",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "memvid_summary",
        description: `Get a summary of all memories for quick context.

Use this at the start of a session to get an overview of stored information.`,
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
      case "memvid_store": {
        const { content, category = "note", tags = [], importance = 5 } = args as any;

        const putData: PutInput = {
          text: content,
          metadata: {
            category,
            tags,
            importance,
            timestamp: new Date().toISOString(),
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
              text: `✅ Memory stored (ID: ${frameId})`,
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
            content: [{ type: "text", text: "No memories found matching the criteria." }],
          };
        }

        const formatted = limited
          .map(([id, data]) => {
            return `[${id}] ${data.category} ${data.tags.join(",")} (importance: ${data.importance}/10)\n${data.content}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `📝 Found ${limited.length} memories:\n\n${formatted}`,
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
            content: [{ type: "text", text: `No memories found for: "${query}"` }],
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
              text: `🔍 Search results for "${query}":\n\n${formatted}`,
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
            content: [{ type: "text", text: "No memories stored yet." }],
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
              text: `📋 Memories (${results.length} total):\n\n${formatted}`,
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
              text: `🗑️ Deleted memory: ${id}`,
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

        return {
          content: [
            {
              type: "text",
              text: `🧠 Memory Summary (${all.length} total)\n\nBy category:\n${categorySummary || "  None"}\n\nRecent memories:\n${recent || "  None yet"}`,
            },
          ],
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
          text: `❌ Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  await initMemvid();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP-Memvid] Server running on stdio");
}

main().catch((error) => {
  console.error("[MCP-Memvid] Fatal error:", error);
  process.exit(1);
});
