import { NvimPlugin } from 'neovim';
import { registerClaudeMcpCommands } from './claude-mcp.js';

/**
 * Claude MCP Server Plugin for Neovim
 *
 * Implements the Model Context Protocol (MCP) for Claude Code integration.
 * Provides WebSocket server with authentication and MCP tools for Neovim interaction.
 *
 * Commands:
 * - :ClaudeMcpServerStart [port] - Start the MCP server on specified port (random if not provided)
 * - :ClaudeMcpServerStop - Stop the MCP server
 * - :ClaudeMcpServerStatus - Show server status and connection info
 *
 * MCP Tools (available to Claude Code clients):
 * - openDiff - Create diff views with new file content
 * - close_tab - Close buffers by tab name or file path
 * - getDiagnostics - Get LSP diagnostics for a file or all files
 * - closeAllDiffTabs - Close all diff windows
 */

export default (plugin: NvimPlugin) => {
  plugin.setOptions({ dev: false });

  // Register Claude MCP server commands
  registerClaudeMcpCommands(plugin);
};
