#!/bin/bash
# Installation script for MCP-Memvid

set -e

INSTALL_DIR="$HOME/.claude/mcp-memvid"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing MCP-Memvid..."

# Create install directory
mkdir -p "$INSTALL_DIR"

# Copy files
cp -r "$SRC_DIR/dist" "$INSTALL_DIR/"
cp -r "$SRC_DIR/node_modules" "$INSTALL_DIR/"
cp "$SRC_DIR/package.json" "$INSTALL_DIR/"
cp "$SRC_DIR/package-lock.json" "$INSTALL_DIR/"

echo "✅ Installed to: $INSTALL_DIR"
echo ""
echo "Add this to ~/.claude.json mcpServers section:"
echo ""
cat <<EOF
  "memvid": {
    "type": "stdio",
    "command": "node",
    "args": ["$INSTALL_DIR/dist/index.js"]
  }
EOF
