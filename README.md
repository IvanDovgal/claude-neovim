# Claude Neovim MCP Server

A Neovim remote plugin that implements the Model Context Protocol (MCP) for seamless integration with Claude Code CLI. This plugin enables Claude to interact with your Neovim editor, providing features like inline diffs, selection tracking, and LSP diagnostics access.

## Features

- **MCP Server Integration**: Exposes Neovim functionality through the Model Context Protocol
- **WebSocket Server**: Secure WebSocket server with authentication for Claude Code communication
- **Inline Diff Views**: View and manage Claude's proposed changes directly in Neovim using mini.diff
- **Selection Tracking**: Send visual selections or cursor positions to Claude Code
- **At-Mentions**: Mention specific code ranges to Claude Code from visual mode
- **LSP Diagnostics**: Provide Claude with access to LSP diagnostics from your codebase
- **Auto-start**: Automatically starts the MCP server when Neovim launches

## Requirements

- Neovim 0.9+ with remote plugin support
- Node.js 18+ and npm
- [mini.diff](https://github.com/echasnovski/mini.nvim/blob/main/readmes/mini-diff.md) plugin for diff visualization
- Claude Code CLI

## Installation

### Using [lazy.nvim](https://github.com/folke/lazy.nvim)

```lua
return {
  'IvanDovgal/claude-neovim',
  lazy = false,
  dependencies = {
    { 'echasnovski/mini.diff', version = false },
  },
  build = 'make && nvim --headless -c "UpdateRemotePlugins" -c "qa"',
  -- Alternative without make:
  -- build = function()
  --   vim.fn.system { 'npm', 'install' }
  --   vim.fn.system { 'npm', 'run', 'build' }
  --   vim.cmd 'UpdateRemotePlugins'
  -- end,
  config = function()
    -- Setup mini.diff
    require('mini.diff').setup()

    -- Create helper commands for diff viewing
    vim.api.nvim_create_user_command('ClaudeActivateBufferDiff', function(opts)
      local bufnr = tonumber(opts.fargs[1])
      if not bufnr then
        vim.notify('Usage: :ClaudeActivateBufferDiff {bufnr}', vim.log.levels.ERROR)
        return
      end
      if not vim.api.nvim_buf_is_valid(bufnr) then
        vim.notify(('Buffer %s is not valid'):format(tostring(bufnr)), vim.log.levels.ERROR)
        return
      end
      if not vim.api.nvim_buf_is_loaded(bufnr) then
        pcall(vim.fn.bufload, bufnr)
      end
      vim.cmd('buffer ' .. bufnr)
    end, {
      nargs = 1,
      desc = 'Activate buffer (like :buffer {bufnr})',
      complete = function(_, line, _)
        local parts = vim.split(line, '%s+')
        return vim.fn.getcompletion(parts[#parts] or '', 'buffer')
      end,
    })

    vim.api.nvim_create_user_command('ClaudeShowFileDiff', function(opts)
      if #opts.fargs ~= 2 then
        vim.notify('Usage: :ClaudeShowFileDiff {bufnr} {path}', vim.log.levels.ERROR)
        return
      end

      local bufnr = tonumber(opts.fargs[1])
      local path = vim.fn.expand(opts.fargs[2])

      if not bufnr or bufnr <= 0 then
        vim.notify('ClaudeShowFileDiff: invalid bufnr', vim.log.levels.ERROR)
        return
      end

      if not vim.api.nvim_buf_is_loaded(bufnr) then
        pcall(vim.fn.bufload, bufnr)
      end
      if not vim.api.nvim_buf_is_valid(bufnr) then
        vim.notify(('ClaudeShowFileDiff: buffer %s is not valid'):format(tostring(bufnr)), vim.log.levels.ERROR)
        return
      end

      local ok, lines = pcall(vim.fn.readfile, path)
      if not ok then
        vim.notify(('ClaudeShowFileDiff: cannot read %s'):format(path), vim.log.levels.ERROR)
        return
      end

      local diff = require('mini.diff')
      vim.b[bufnr].minidiff_config = { source = diff.gen_source.none() }
      diff.enable(bufnr)
      diff.set_ref_text(bufnr, lines)
      diff.toggle_overlay(bufnr)
    end, {
      nargs = '+',
      desc = 'Inline diff: compare {bufnr} against {path}',
      complete = function(_, line, _)
        local parts = vim.split(line, '%s+')
        if #parts >= 3 then
          return vim.fn.getcompletion(parts[#parts], 'file')
        end
        return {}
      end,
    })

    -- Auto-start MCP server on VimEnter
    vim.api.nvim_create_autocmd('VimEnter', {
      once = true,
      callback = function()
        if vim.fn.exists(':ClaudeMcpServerStart') > 0 then
          vim.cmd('silent! ClaudeMcpServerStart')
        end
      end,
    })

    -- Setup keymaps (customize to your preference)
    vim.keymap.set('n', '<leader>aca', ':ClaudeAccept<CR>', { desc = 'Claude Accept Changes', silent = true })
    vim.keymap.set('n', '<leader>acd', ':ClaudeDrop<CR>', { desc = 'Claude Drop Changes', silent = true })
    vim.keymap.set('n', '<leader>act', ':ClaudeStartSelectionTracking<CR>', { desc = 'Claude Start Tracking', silent = true })
    vim.keymap.set('n', '<leader>acT', ':ClaudeStopSelectionTracking<CR>', { desc = 'Claude Stop Tracking', silent = true })
    vim.keymap.set('v', '<leader>acm', ":'<,'>ClaudeMention<CR>", { desc = 'Claude Mention Selection', silent = true })
  end,
}
```

## Commands

### Server Management

- `:ClaudeMcpServerStart [port]` - Start the MCP server on the specified port (random if not provided)
- `:ClaudeMcpServerStop` - Stop the MCP server
- `:ClaudeMcpServerStatus` - Show server status, port, and connection info

### Diff Management

- `:ClaudeAccept` - Accept Claude's proposed changes in the current diff buffer
- `:ClaudeDrop` - Reject and drop Claude's proposed changes

**User-defined commands (from sample configuration):**

- `:ClaudeActivateBufferDiff {bufnr}` - Activate and display a diff buffer. Called by the plugin to show Claude's suggested changes. The sample implementation uses `:buffer {bufnr}`, but you can customize this to open in a floating popup, split window, or distraction-free mode based on your preference
- `:ClaudeShowFileDiff {bufnr} {path}` - Show inline diff comparing a buffer against a file. Called by the plugin when Claude suggests code changes. First argument is the buffer number containing Claude's suggested code, second argument is the path to the file where it will be saved. This is defined in the sample mini.diff integration and should be customized based on your diff plugin

### Selection & Mention

- `:ClaudeStartSelectionTracking [bufnr]` - Start tracking cursor/selection in current or specified buffer
- `:ClaudeStopSelectionTracking [bufnr]` - Stop tracking cursor/selection
- `:ClaudeMention` - Send the current visual selection as an at-mention to Claude (use in visual mode)

## MCP Tools

The plugin exposes the following MCP tools to Claude Code:

### `openDiff`

Creates a new diff view for proposed file changes.

**Input:**
- `filePath` (string): Absolute path to the file
- `newFileContent` (string): Proposed new content
- `tabName` (optional string): Custom name for the diff tab

**Returns:**
- Buffer number of the created diff view

### `close_tab`

Closes buffers by tab name or file path.

**Input:**
- `tabName` (optional string): Tab name to close
- `filePath` (optional string): File path to close

### `getDiagnostics`

Retrieves LSP diagnostics for files.

**Input:**
- `filePath` (optional string): Specific file to get diagnostics for (all files if not provided)

**Returns:**
- Array of diagnostic objects with file path, line numbers, severity, source, and message

### `closeAllDiffTabs`

Closes all diff windows created by the plugin.

### `executeCode` (⚠️ Unsafe - Optional)

**Only available when `g:claude_unsafe_execute_lua` is set to `true`.**

Executes arbitrary Lua code in Neovim context.

**Input:**
- `code` (string): Lua code to execute

**Returns:**
- Result of the Lua code execution (or error message)

**Example:**
```json
{
  "code": "return vim.fn.getcwd()"
}
```

⚠️ **WARNING**: This tool can execute arbitrary code and is potentially dangerous. Only enable if you understand the security implications.

## How It Works

1. **MCP Server**: The plugin starts a WebSocket server on Neovim launch (or manually with `:ClaudeMcpServerStart`)
2. **Lock File**: Creates a lock file at `~/.claude/ide/{port}.lock` that Claude Code uses to discover the connection
3. **Authentication**: Uses challenge-response authentication to secure the WebSocket connection
4. **MCP Protocol**: Communicates with Claude Code using the Model Context Protocol over WebSocket
5. **Diff Viewing**: Uses mini.diff to show inline diffs with overlay for deleted lines and word-level changes
6. **Selection Tracking**: Monitors cursor movements and visual selections to sync with Claude Code
7. **Auto-cleanup**: Automatically stops the server when Neovim exits

## Workflow Example

1. Open Neovim - the MCP server starts automatically
2. In Claude Code CLI, the plugin is automatically detected
3. Ask Claude to make changes to a file
4. Claude creates a diff buffer in Neovim using the `openDiff` tool
5. Review the changes in the diff view
6. Accept with `:ClaudeAccept` or reject with `:ClaudeDrop`
7. If accepted, Claude saves the changes to the file

## Selection Tracking

Selection tracking allows Claude to see your cursor position or visual selection:

1. Enable tracking: `:ClaudeStartSelectionTracking`
2. Move your cursor or make visual selections
3. Claude receives real-time updates about your selection
4. Use in visual mode: `<leader>acm` to mention the selected code to Claude
5. Disable tracking: `:ClaudeStopSelectionTracking`

## Configuration

### Environment Variables

- `CLAUDE_IDE_LOG_LEVEL` - Control logging verbosity. Valid values:
  - `ERROR` - Only log errors
  - `WARN` - Log warnings and errors
  - `INFO` - Log informational messages, warnings, and errors (default)
  - `DEBUG` - Log debug information including WebSocket messages and all above

Example:
```bash
CLAUDE_IDE_LOG_LEVEL=DEBUG nvim
```

### Global Variables

- `g:claude_ide_port` - Contains the port number of the running MCP server (0 when stopped). Useful for statusline integration or other custom integrations.

- `g:claude_unsafe_execute_lua` - **⚠️ DANGEROUS**: When set to `true` (or `1`), enables the `executeCode` MCP tool that allows Claude to execute arbitrary Lua code in your Neovim context. This is extremely powerful but potentially dangerous. Only enable this if you understand the security implications and trust the code being executed.

**Example:**
```lua
-- Enable unsafe Lua execution (use with caution!)
vim.g.claude_unsafe_execute_lua = true
```

**Example statusline integration:**
```lua
-- Add to your statusline configuration
local function claude_status()
  local port = vim.g.claude_ide_port or 0
  if port > 0 then
    return string.format('Claude:%d', port)
  end
  return ''
end

-- For lualine
require('lualine').setup {
  sections = {
    lualine_x = { claude_status, 'encoding', 'fileformat', 'filetype' },
  }
}
```

## Troubleshooting

### Server won't start

- Make sure Node.js 18+ is installed
- Check that the plugin was built: `npm run build` in the plugin directory
- Run `:UpdateRemotePlugins` and restart Neovim

### Claude Code doesn't detect Neovim

- Check server status with `:ClaudeMcpServerStatus`
- Verify lock file exists at `~/.claude/ide/{port}.lock`
- Try manually restarting: `:ClaudeMcpServerStop` then `:ClaudeMcpServerStart`

### Diff view not showing

- Ensure mini.diff is installed and loaded
- Check that the buffer is valid with `:ls`
- Try manually activating with `:ClaudeActivateBufferDiff {bufnr}`

## Development

### Using Make (Recommended)

```bash
# Install dependencies and build
make

# Or run individual targets
make install    # Install npm dependencies
make build      # Build TypeScript code
make dev        # Run compiler in watch mode
make clean      # Clean build artifacts
make help       # Show all available targets
```

### Using npm directly

```bash
cd rplugin/node/claude-nvim

# Install dependencies
npm install

# Build
npm run build

# Watch mode for development
npm run dev

# Clean build artifacts
npm run clean
```

After making changes, run `:UpdateRemotePlugins` in Neovim and restart.

## Architecture

- **src/index.ts**: Plugin entry point and command registration
- **src/claude-mcp.ts**: MCP server manager and command handlers
- **src/mcp-tools.ts**: MCP tool implementations (openDiff, getDiagnostics, etc.)
- **src/ws-server.ts**: WebSocket server with authentication
- **src/ws-transport.ts**: WebSocket transport for MCP protocol
- **src/logger.ts**: Async logging utility with configurable log levels

## Credits

This project was inspired by [claudecode.nvim](https://github.com/coder/claudecode.nvim) by Coder. Special thanks for pioneering the MCP integration pattern for Neovim.

## License

MIT
