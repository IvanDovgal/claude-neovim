import { NvimPlugin } from 'neovim';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Logger } from './logger.js';

interface DiffChangeHandlers {
  acceptChanges: (changeId: string) => Promise<boolean>;
  dropChanges: (changeId: string) => Promise<boolean>;
}

/**
 * Registers all MCP tools matching the exact specification.
 *
 * @param plugin - Neovim plugin instance
 * @param mcpServer - MCP server instance to register tools on
 * @param logger - Logger instance for tool execution logging
 * @param unsafeExecuteLua - Whether to register the unsafe executeCode tool
 * @returns Handlers for accepting/dropping changes
 */
export function registerNvimMcpTools(plugin: NvimPlugin, mcpServer: McpServer, logger?: Logger, unsafeExecuteLua?: boolean): DiffChangeHandlers {
  const nvim = plugin.nvim;
  const toolLogger = logger?.child('Tools') || new Logger(plugin, 'Tools');

  // Helper function to check if a command exists
  const commandExists = async (command: string): Promise<boolean> => {
    const result = await nvim.call('exists', [`:${command}`]) as number;
    return result === 2;
  };

  // Store diff buffers and their promises
  const diffPromises = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: string) => void;
    filePath: string;
    bufnr: number;
  }>();

  // Accept changes handler
  const acceptChanges = async (changeId: string): Promise<boolean> => {
    if (!diffPromises.has(changeId)) {
      return false;
    }

    const { resolve, filePath } = diffPromises.get(changeId)!;

    try {
      // Get buffer content
      const bufnr = parseInt(changeId.split('/')[1]);
      const buffers = await nvim.buffers;
      const buffer = buffers.find(buf => buf.id === bufnr);

      if (!buffer) {
        await toolLogger.error(`Buffer ${bufnr} not found`);
        return false;
      }

      const lines = await buffer.lines;
      const content = lines.join('\n');

      // Clear modified flag
      await buffer.setOption('modified', false);

      diffPromises.delete(changeId);

      resolve([
        { type: 'text', text: 'FILE_SAVED' },
        { type: 'text', text: content }
      ]);
      await toolLogger.info(`Accepted changes for ${filePath}`);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await toolLogger.error(`Error accepting changes: ${message}`);
      return false;
    }
  };

  // Drop changes handler
  const dropChanges = async (changeId: string): Promise<boolean> => {
    if (!diffPromises.has(changeId)) {
      return false;
    }

    const { resolve } = diffPromises.get(changeId)!;

    try {
      // Get buffer and clear modified flag
      const bufnr = parseInt(changeId.split('/')[1]);
      const buffers = await nvim.buffers;
      const buffer = buffers.find(buf => buf.id === bufnr);

      if (buffer) {
        await buffer.setOption('modified', false);
      }

      diffPromises.delete(changeId);

      resolve([{ type: 'text', text: 'DIFF_REJECTED' }]);
      await toolLogger.info('Rejected changes');

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await toolLogger.error(`Error rejecting changes: ${message}`);
      return false;
    }
  };

  // Tool 1: openDiff
  mcpServer.registerTool(
    'openDiff',
    {
      description: 'Opens a diff in the IDE',
      inputSchema: {
        old_file_path: z.string(),
        new_file_path: z.string(),
        new_file_contents: z.string(),
        tab_name: z.string()
      }
    },
    async ({ old_file_path, new_file_path, new_file_contents, tab_name }) => {
      // Create new listed buffer
      const bufnr = await nvim.call('nvim_create_buf', [true, false]) as number;

      // Get Neovim PID
      const pid = await nvim.call('getpid') as number;
      const changeId = `${pid}/${bufnr}`;

      // Activate the buffer
      if (await commandExists('ClaudeActivateBufferDiff')) {
        await nvim.command(`ClaudeActivateBufferDiff ${bufnr}`);
      }

      // Get the buffer
      const buffer = await nvim.buffer;

      // Set buffer options
      await buffer.setOption('buftype', 'acwrite');
      await buffer.setOption('swapfile', false);

      // Set buffer content
      const lines = new_file_contents.split('\n');
      await buffer.setLines(lines, { start: 0, end: -1, strictIndexing: false });

      // Set buffer name
      const buffers = await nvim.buffers;
      buffers.filter(buf => buf.id === bufnr).forEach(buf => {
        buf.name = tab_name;
      });

      // Set filetype based on file extension
      const { extname } = require('path');
      const fileExt = extname(new_file_path).slice(1); // Remove the dot
      if (fileExt) {
        await buffer.setOption('filetype', fileExt);
      }

      // Register BufWriteCmd for this buffer to call ClaudeAccept
      await nvim.command(`autocmd BufWriteCmd <buffer=${bufnr}> ClaudeAccept`);

      // Call ClaudeShowFileDiff command if it exists
      if (await commandExists('ClaudeShowFileDiff')) {
        await nvim.command(`ClaudeShowFileDiff ${bufnr} ${new_file_path}`);
      }

      // Create promise for this diff
      const resultPromise = new Promise<any>((resolve, reject) => {
        diffPromises.set(changeId, {
          resolve,
          reject,
          filePath: new_file_path,
          bufnr
        });
      });

      // Wait for user to accept or reject
      const promiseResult = await resultPromise;

      return {
        content: promiseResult
      };
    }
  );

  // Tool 2: close_tab
  mcpServer.registerTool(
    'close_tab',
    {
      description: 'Closes a tab in the IDE, given either the tab_name used in openDiff or the\nabsolute file path.',
      inputSchema: {
        tab_name: z.string()
      }
    },
    async ({ tab_name }) => {
      const bufnr = await nvim.call('bufnr', [tab_name]) as number;

      if (bufnr !== -1) {
        // Check if this buffer is a diff buffer
        const pid = await nvim.call('getpid') as number;
        const changeId = `${pid}/${bufnr}`;
        const isDiffBuffer = diffPromises.has(changeId);

        // Delete with force only if it's a diff buffer
        if (isDiffBuffer) {
          await nvim.command(`bdelete! ${bufnr}`);
        } else {
          await nvim.command(`bdelete ${bufnr}`);
        }
      }

      return {
        content: [{ type: 'text', text: 'TAB_CLOSED' }]
      };
    }
  );

  // Tool 3: getDiagnostics
  mcpServer.registerTool(
    'getDiagnostics',
    {
      description: 'Gets diagnostic info.',
      inputSchema: {
        uri: z.string().optional()
      }
    },
    async ({ uri }) => {
      try {
        let diagnostics: any[];
        let fileName: string | null = null;

        if (uri) {
          // Convert file:// URI to file path
          let filePath = uri;
          if (uri.startsWith('file://')) {
            filePath = uri.substring(7); // Remove 'file://'
          }

          // Get diagnostics for specific buffer
          const bufnr = await nvim.call('bufnr', [filePath]) as number;
          if (bufnr === -1) {
            return {
              content: [{ type: 'text', text: JSON.stringify([]) }]
            };
          }
          diagnostics = await nvim.call('luaeval', [
            'vim.diagnostic.get(tonumber(...))',
            bufnr
          ]) as any[];
          fileName = filePath;
        } else {
          // Get diagnostics for all buffers
          diagnostics = await nvim.call('luaeval', [
            'vim.diagnostic.get()'
          ]) as any[];
        }

        const formatted = await Promise.all(diagnostics.map(async (diag: any) => {
          // Get file name for this diagnostic's buffer
          let file = fileName;
          if (!file && diag.bufnr) {
            file = await nvim.call('bufname', [diag.bufnr]) as string;
          }

          // Convert to file:// URI format
          let fileUri = 'unknown';
          if (file) {
            fileUri = file.startsWith('/') ? `file://${file}` : file;
          }

          return {
            message: diag.message,
            severity: diag.severity,
            range: {
              start: { line: diag.lnum, character: diag.col },
              end: { line: diag.end_lnum || diag.lnum, character: diag.end_col || diag.col }
            },
            source: diag.source || 'neovim',
            uri: fileUri
          };
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify(formatted) }]
        };
      } catch {
        return {
          content: [{ type: 'text', text: JSON.stringify([]) }]
        };
      }
    }
  );

  // Tool 4: closeAllDiffTabs
  mcpServer.registerTool(
    'closeAllDiffTabs',
    {
      description: 'Close all diff tabs in the editor',
      inputSchema: {}
    },
    async () => {
      let closedCount = 0;

      // Delete all diff buffers (force)
      for (const [changeId, { bufnr }] of diffPromises.entries()) {
        try {
          await nvim.command(`bdelete! ${bufnr}`);
          closedCount++;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toolLogger.warn(`Error closing diff buffer ${bufnr}: ${message}`).catch(() => {});
        }
      }

      return {
        content: [{ type: 'text', text: `CLOSED_${closedCount}_DIFF_TABS` }]
      };
    }
  );

  // Tool 5: executeCode (unsafe - only registered if enabled)
  if (unsafeExecuteLua) {
    mcpServer.registerTool(
      'executeCode',
      {
        description: 'Execute Lua code in Neovim context. WARNING: This can execute arbitrary code and is potentially dangerous.',
        inputSchema: {
          code: z.string()
        }
      },
      async ({ code }) => {
        try {
          await toolLogger.warn(`Executing Lua code: ${code}`);

          // Execute the Lua code using nvim_exec_lua
          // Wrap the code in a function that returns the result
          const wrappedCode = `return (function() ${code} end)()`;
          const result = await nvim.call('nvim_exec_lua', [wrappedCode, []]) as any;

          // Convert result to string
          let resultStr: string;
          if (result === null || result === undefined) {
            resultStr = 'nil';
          } else if (typeof result === 'object') {
            resultStr = JSON.stringify(result, null, 2);
          } else {
            resultStr = String(result);
          }

          await toolLogger.info(`Lua execution result: ${resultStr}`);

          return {
            content: [{ type: 'text', text: resultStr }]
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await toolLogger.error(`Lua execution error: ${message}`);

          return {
            content: [{ type: 'text', text: `ERROR: ${message}` }]
          };
        }
      }
    );
  }

  return {
    acceptChanges,
    dropChanges
  };
}
