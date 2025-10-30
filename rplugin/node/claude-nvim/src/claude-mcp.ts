import { NvimPlugin } from 'neovim';
import { WebSocketServer, WebSocket } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClaudeWebSocketServer } from './ws-server.js';
import { WebSocketTransport } from './ws-transport.js';
import { registerNvimMcpTools } from './mcp-tools.js';
import { Logger } from './logger.js';

/**
 * Claude MCP Server Manager
 * Manages WebSocket server and MCP server instances for each connected client
 */
interface DiffChangeHandlers {
  acceptChanges: (changeId: string) => Promise<boolean>;
  dropChanges: (changeId: string) => Promise<boolean>;
}

export class ClaudeMcpServerManager {
  private plugin: NvimPlugin;
  private wss: WebSocketServer | null = null;
  private port: number;
  private clientServers: Map<WebSocket, McpServer> = new Map();
  private changeHandlers: DiffChangeHandlers[] = [];
  private selectionTracking: Map<number, number> = new Map(); // bufnr -> autocmd id
  private lastSelectionBuffer: number | null = null; // Last buffer where selection was sent
  private healthCheckIntervals: Map<WebSocket, NodeJS.Timeout> = new Map(); // Health check intervals per client
  private logger: Logger;

  constructor(plugin: NvimPlugin, port?: number) {
    this.plugin = plugin;
    this.port = port || this.getRandomPort();
    this.logger = new Logger(plugin, 'MCP');
  }

  /**
   * Get a random port in the range 10000-65535
   */
  private getRandomPort(): number {
    return Math.floor(Math.random() * (65535 - 10000 + 1)) + 10000;
  }

  /**
   * Start the Claude WebSocket server
   */
  async start(): Promise<void> {
    if (this.wss) {
      throw new Error('Server is already running');
    }

    // Get workspace folders from Neovim
    const cwd = await this.plugin.nvim.call('getcwd') as string;

    // Create WebSocket server with authentication
    this.wss = createClaudeWebSocketServer({
      port: this.port,
      path: '/',
      workspaceFolders: [cwd],
      ideName: 'neovim'
    });

    // Handle new client connections
    this.wss.on('connection', (ws: WebSocket) => {
      this.handleClient(ws);
    });

    // Handle errors
    this.wss.on('error', (error: Error) => {
      this.logger.error(`WebSocket server error: ${error.message}`).catch(() => {});
    });

    // Save port to global variable
    await this.plugin.nvim.setVar('claude_ide_port', this.port);

    await this.logger.info(`Server started on port ${this.port}`);
    await this.logger.info(`Lock file: ~/.claude/ide/${this.port}.lock`);
  }

  /**
   * Handle a new client connection
   */
  private async handleClient(ws: WebSocket): Promise<void> {
    try {

      // Create MCP server instance for this client
      const mcpServer = new McpServer({
        name: 'neovim-mcp-server',
        version: '1.0.0'
      });

      // Check if unsafe Lua execution is enabled
      const unsafeExecuteLua = await this.plugin.nvim.getVar('claude_unsafe_execute_lua') as boolean | undefined;
      if (unsafeExecuteLua) {
        await this.logger.warn('Unsafe Lua code execution is ENABLED via g:claude_unsafe_execute_lua');
      }

      // Register all Neovim tools and get change handlers BEFORE connecting
      const handlers = registerNvimMcpTools(this.plugin, mcpServer, this.logger, unsafeExecuteLua);
      this.changeHandlers.push(handlers);

      // Create transport for this WebSocket with logging
      const transport = new WebSocketTransport(ws, this.logger.child('Transport'));

      // Connect MCP server to transport
      await mcpServer.connect(transport);

      await this.logger.info('Client connected');

      // Store the server instance
      this.clientServers.set(ws, mcpServer);

      // Setup health check - ping every 3 seconds
      let pingId = 0;
      const healthCheckInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            // Send ping request directly through WebSocket
            const pingMessage = {
              id: pingId++,
              method: 'ping',
              params: { method: 'ping' },
              jsonrpc: '2.0' as const
            };
            ws.send(JSON.stringify(pingMessage), (error) => {
              if (error) {
                // Ping failed, close connection
                this.logger.warn('Health check failed, closing connection').catch(() => {});
                clearInterval(healthCheckInterval);
                ws.close();
              }
            });
          } catch (error) {
            // Ping failed, close connection
            this.logger.warn('Health check failed, closing connection').catch(() => {});
            clearInterval(healthCheckInterval);
            ws.close();
          }
        }
      }, 3000);

      this.healthCheckIntervals.set(ws, healthCheckInterval);

      // Handle client disconnect
      ws.on('close', async () => {
        await this.logger.info('Client disconnected');

        // Clear health check interval
        const interval = this.healthCheckIntervals.get(ws);
        if (interval) {
          clearInterval(interval);
          this.healthCheckIntervals.delete(ws);
        }

        this.clientServers.delete(ws);
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logger.error(`Error handling client: ${message}`);
      ws.close();
    }
  }

  /**
   * Stop the Claude WebSocket server
   */
  async stop(): Promise<void> {
    if (!this.wss) {
      throw new Error('Server is not running');
    }

    // Close all client connections
    for (const [ws, mcpServer] of this.clientServers.entries()) {
      try {
        // Clear health check interval
        const interval = this.healthCheckIntervals.get(ws);
        if (interval) {
          clearInterval(interval);
        }

        await mcpServer.close();
        ws.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Error closing client: ${message}`).catch(() => {});
      }
    }

    this.clientServers.clear();
    this.healthCheckIntervals.clear();

    // Close the WebSocket server
    await new Promise<void>((resolve, reject) => {
      this.wss!.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    this.wss = null;

    // Clear port from global variable
    await this.plugin.nvim.setVar('claude_ide_port', 0);

    await this.logger.info('Server stopped');
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.wss !== null;
  }

  /**
   * Get the server port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get the number of connected clients
   */
  getClientCount(): number {
    return this.clientServers.size;
  }

  /**
   * Accept changes for a given changeId
   */
  async acceptChanges(changeId: string): Promise<boolean> {
    for (const handler of this.changeHandlers) {
      if (await handler.acceptChanges(changeId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Drop changes for a given changeId
   */
  async dropChanges(changeId: string): Promise<boolean> {
    for (const handler of this.changeHandlers) {
      if (await handler.dropChanges(changeId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Send selection_changed notification to all connected clients
   */
  private async sendSelectionChanged(bufnr: number): Promise<void> {
    if (!this.wss) {
      return;
    }

    const nvim = this.plugin.nvim;

    try {
      // Get buffer
      const buffers = await nvim.buffers;
      const buffer = buffers.find(buf => buf.id === bufnr);
      if (!buffer) {
        return;
      }

      // Get file path
      const filePath = await buffer.name;
      if (!filePath) {
        return;
      }

      // Check if we're in visual mode
      const mode = await nvim.mode;
      const isVisual = mode.mode === 'v' || mode.mode === 'V' || mode.mode === '\x16';

      let start: { line: number; character: number };
      let end: { line: number; character: number };
      let text = '';
      let isEmpty = false;

      if (isVisual) {
        // Get current visual selection
        const startPos = await nvim.call('getpos', ['v']) as [number, number, number, number];
        const endPos = await nvim.call('getcurpos') as [number, number, number, number, number];

        // Ensure start is before end
        let startLine = startPos[1];
        let startCol = startPos[2];
        let endLine = endPos[1];
        let endCol = endPos[2];

        if (startLine > endLine || (startLine === endLine && startCol > endCol)) {
          [startLine, startCol, endLine, endCol] = [endLine, endCol, startLine, startCol];
        }

        start = { line: startLine - 1, character: startCol - 1 };
        end = { line: endLine - 1, character: endCol };
        isEmpty = start.line === end.line && start.character === end.character;

        // Get selected text
        const lines = await nvim.call('getline', [startLine, endLine]) as string[];
        if (lines.length === 1) {
          text = lines[0].substring(startCol - 1, endCol);
        } else if (lines.length > 1) {
          text = lines[0].substring(startCol - 1) + '\n' +
                 lines.slice(1, -1).join('\n') +
                 (lines.length > 1 ? '\n' : '') +
                 lines[lines.length - 1].substring(0, endCol);
        }
      } else {
        // Not in visual mode, send cursor position as empty selection
        const cursorPos = await nvim.call('getcurpos') as [number, number, number, number, number];
        start = { line: cursorPos[1] - 1, character: cursorPos[2] - 1 };
        end = { line: cursorPos[1] - 1, character: cursorPos[2] - 1 };
        isEmpty = true;
        text = '';
      }

      // Send notification to all clients
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'selection_changed',
        params: {
          text,
          filePath,
          fileUrl: `file://${filePath}`,
          selection: {
            start,
            end,
            isEmpty
          }
        }
      };

      const notificationStr = JSON.stringify(notification);

      // Log outgoing message
      await this.logger.debug(`Selection changed: ${notificationStr}`);

      for (const ws of this.clientServers.keys()) {
        if (ws.readyState === ws.OPEN) {
          ws.send(notificationStr);
        }
      }

      // Remember the buffer we sent selection for
      this.lastSelectionBuffer = bufnr;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error sending selection: ${message}`).catch(() => {});
    }
  }

  /**
   * Send empty selection notification
   */
  private async sendEmptySelection(bufnr: number): Promise<void> {
    if (!this.wss) {
      return;
    }

    const nvim = this.plugin.nvim;

    try {
      // Get buffer
      const buffers = await nvim.buffers;
      const buffer = buffers.find(buf => buf.id === bufnr);
      if (!buffer) {
        return;
      }

      // Get file path
      const filePath = await buffer.name;
      if (!filePath) {
        return;
      }

      // Get cursor position
      const cursorPos = await nvim.call('getcurpos') as [number, number, number, number, number];
      const start = { line: cursorPos[1] - 1, character: cursorPos[2] - 1 };
      const end = { line: cursorPos[1] - 1, character: cursorPos[2] - 1 };

      // Send empty selection notification
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'selection_changed',
        params: {
          text: '',
          filePath,
          fileUrl: `file://${filePath}`,
          selection: {
            start,
            end,
            isEmpty: true
          }
        }
      };

      const notificationStr = JSON.stringify(notification);

      // Log outgoing message
      await this.logger.debug(`Selection changed: ${notificationStr}`);

      for (const ws of this.clientServers.keys()) {
        if (ws.readyState === ws.OPEN) {
          ws.send(notificationStr);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error sending empty selection: ${message}`).catch(() => {});
    }
  }

  /**
   * Start selection tracking for a buffer
   */
  async startSelectionTracking(bufnr: number): Promise<void> {
    if (this.selectionTracking.has(bufnr)) {
      return; // Already tracking
    }

    // Store tracking state
    this.selectionTracking.set(bufnr, 1);

    await this.logger.info(`Started selection tracking for buffer ${bufnr}`);
  }

  /**
   * Stop selection tracking for a buffer
   */
  async stopSelectionTracking(bufnr: number): Promise<void> {
    if (!this.selectionTracking.has(bufnr)) {
      return; // Not tracking
    }

    this.selectionTracking.delete(bufnr);

    // If this was the last buffer where we sent selection, send empty selection
    if (this.lastSelectionBuffer === bufnr) {
      await this.sendEmptySelection(bufnr);
      this.lastSelectionBuffer = null;
    }

    await this.logger.info(`Stopped selection tracking for buffer ${bufnr}`);
  }

  /**
   * Check if buffer is being tracked and send selection update
   */
  async handleSelectionUpdate(bufnr: number): Promise<void> {
    if (!this.selectionTracking.has(bufnr)) {
      return;
    }

    await this.sendSelectionChanged(bufnr);
  }

  /**
   * Send at_mentioned notification for a range
   */
  async sendAtMention(filePath: string, lineStart: number, lineEnd: number): Promise<void> {
    if (!this.wss) {
      return;
    }

    const notification = {
      jsonrpc: '2.0' as const,
      method: 'at_mentioned',
      params: {
        filePath,
        lineStart,
        lineEnd
      }
    };

    const notificationStr = JSON.stringify(notification);

    // Log outgoing message
    await this.logger.debug(`At-mention: ${notificationStr}`);

    for (const ws of this.clientServers.keys()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(notificationStr);
      }
    }
  }
}

/**
 * Global server manager instance
 */
let serverManager: ClaudeMcpServerManager | null = null;

/**
 * Global logger instance for commands
 */
let commandLogger: Logger | null = null;

/**
 * Register Claude MCP commands with Neovim
 */
export function registerClaudeMcpCommands(plugin: NvimPlugin): void {
  // Initialize command logger
  if (!commandLogger) {
    commandLogger = new Logger(plugin, 'Command');
  }
  // Set up global selection tracking autocmds
  plugin.registerAutocmd(
    'CursorMoved',
    async () => {
      if (!serverManager || !serverManager.isRunning()) {
        return;
      }
      const bufnr = (await plugin.nvim.buffer).id;
      await serverManager.handleSelectionUpdate(bufnr);
    },
    {
      pattern: '*',
      sync: false
    }
  );

  plugin.registerAutocmd(
    'CursorMovedI',
    async () => {
      if (!serverManager || !serverManager.isRunning()) {
        return;
      }
      const bufnr = (await plugin.nvim.buffer).id;
      await serverManager.handleSelectionUpdate(bufnr);
    },
    {
      pattern: '*',
      sync: false
    }
  );

  plugin.registerAutocmd(
    'TextYankPost',
    async () => {
      if (!serverManager || !serverManager.isRunning()) {
        return;
      }
      const bufnr = (await plugin.nvim.buffer).id;
      await serverManager.handleSelectionUpdate(bufnr);
    },
    {
      pattern: '*',
      sync: false
    }
  );

  // Register VimLeavePre autocmd to stop server when Neovim closes
  plugin.registerAutocmd(
    'VimLeavePre',
    async () => {
      if (serverManager && serverManager.isRunning()) {
        try {
          await serverManager.stop();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          commandLogger?.error(`Error stopping server on VimLeavePre: ${message}`).catch(() => {});
        }
      }
    },
    {
      pattern: '*',
      sync: false
    }
  );

  // Command: ClaudeMcpServerStart
  plugin.registerCommand(
    'ClaudeMcpServerStart',
    async (args: string[]) => {
      try {
        if (serverManager && serverManager.isRunning()) {
          await commandLogger?.warn('Claude MCP Server is already running');
          return;
        }

        const port = args[0] ? parseInt(args[0], 10) : undefined;

        serverManager = new ClaudeMcpServerManager(plugin, port);
        await serverManager.start();

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await commandLogger?.error(`Failed to start Claude MCP Server: ${message}`);
      }
    },
    {
      nargs: '?',
      sync: false
    }
  );

  // Command: ClaudeMcpServerStop
  plugin.registerCommand(
    'ClaudeMcpServerStop',
    async () => {
      try {
        if (!serverManager || !serverManager.isRunning()) {
          await commandLogger?.warn('Claude MCP Server is not running');
          return;
        }

        await serverManager.stop();
        serverManager = null;

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await commandLogger?.error(`Failed to stop Claude MCP Server: ${message}`);
      }
    },
    {
      sync: false
    }
  );

  // Command: ClaudeMcpServerStatus
  plugin.registerCommand(
    'ClaudeMcpServerStatus',
    async () => {
      try {
        if (!serverManager || !serverManager.isRunning()) {
          await commandLogger?.info('Claude MCP Server: Not running');
          return;
        }

        const port = serverManager.getPort();
        const clients = serverManager.getClientCount();

        await commandLogger?.info('Claude MCP Server: Running');
        await commandLogger?.info(`Port: ${port}`);
        await commandLogger?.info(`Connected clients: ${clients}`);
        await commandLogger?.info(`Lock file: ~/.claude/ide/${port}.lock`);

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await commandLogger?.error(`Error getting status: ${message}`);
      }
    },
    {
      sync: false
    }
  );

  // Command: ClaudeAccept
  plugin.registerCommand(
    'ClaudeAccept',
    async () => {
      try {
        if (!serverManager || !serverManager.isRunning()) {
          await commandLogger?.warn('Claude MCP Server is not running');
          return;
        }

        const buffer = await plugin.nvim.buffer;
        const bufnr = buffer.id;
        const pid = await plugin.nvim.call('getpid') as number;
        const changeId = `${pid}/${bufnr}`;

        const handled = await serverManager.acceptChanges(changeId);
        if (!handled) {
          await commandLogger?.warn('This is not a claude code diff');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await commandLogger?.error(`Error accepting changes: ${message}`);
      }
    },
    {
      sync: false
    }
  );

  // Command: ClaudeDrop
  plugin.registerCommand(
    'ClaudeDrop',
    async () => {
      try {
        if (!serverManager || !serverManager.isRunning()) {
          await commandLogger?.warn('Claude MCP Server is not running');
          return;
        }

        const buffer = await plugin.nvim.buffer;
        const bufnr = buffer.id;
        const pid = await plugin.nvim.call('getpid') as number;
        const changeId = `${pid}/${bufnr}`;

        const handled = await serverManager.dropChanges(changeId);
        if (!handled) {
          await commandLogger?.warn('This is not a claude code diff');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await commandLogger?.error(`Error dropping changes: ${message}`);
      }
    },
    {
      sync: false
    }
  );

  // Autocmd: BufWipeout - automatically drop changes when diff buffer is wiped out
  plugin.registerAutocmd(
    'BufWipeout',
    async (bufnrStr: string) => {
      if (!serverManager || !serverManager.isRunning()) {
        return;
      }

      const bufnr = parseInt(bufnrStr);
      const pid = await plugin.nvim.call('getpid') as number;
      const changeId = `${pid}/${bufnr}`;

      await serverManager.dropChanges(changeId);
      await serverManager.stopSelectionTracking(bufnr);
    },
    {
      pattern: '*',
      eval: 'expand("<abuf>")',
      sync: false
    }
  );

  // Command: ClaudeStartSelectionTracking
  plugin.registerCommand(
    'ClaudeStartSelectionTracking',
    async (args: string[]) => {
      try {
        if (!serverManager || !serverManager.isRunning()) {
          await commandLogger?.warn('Claude MCP Server is not running');
          return;
        }

        const bufnr = args[0] ? parseInt(args[0], 10) : (await plugin.nvim.buffer).id;
        await serverManager.startSelectionTracking(bufnr);

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await commandLogger?.error(`Failed to start selection tracking: ${message}`);
      }
    },
    {
      nargs: '?',
      sync: false
    }
  );

  // Command: ClaudeStopSelectionTracking
  plugin.registerCommand(
    'ClaudeStopSelectionTracking',
    async (args: string[]) => {
      try {
        if (!serverManager || !serverManager.isRunning()) {
          await commandLogger?.warn('Claude MCP Server is not running');
          return;
        }

        const bufnr = args[0] ? parseInt(args[0], 10) : (await plugin.nvim.buffer).id;
        await serverManager.stopSelectionTracking(bufnr);

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await commandLogger?.error(`Failed to stop selection tracking: ${message}`);
      }
    },
    {
      nargs: '?',
      sync: false
    }
  );

  // Command: ClaudeMention
  plugin.registerCommand(
    'ClaudeMention',
    async () => {
      try {
        if (!serverManager || !serverManager.isRunning()) {
          await commandLogger?.warn('Claude MCP Server is not running');
          return;
        }

        const buffer = await plugin.nvim.buffer;
        const filePath = await buffer.name;

        if (!filePath) {
          await commandLogger?.warn('Buffer has no file path');
          return;
        }

        // Get visual selection marks
        const startPos = await plugin.nvim.call('getpos', ["'<"]) as [number, number, number, number];
        const endPos = await plugin.nvim.call('getpos', ["'>"]) as [number, number, number, number];

        if (startPos[1] === 0 || endPos[1] === 0) {
          await commandLogger?.warn('No visual selection');
          return;
        }

        // Convert from 1-indexed (Vim) to 0-indexed (at_mentioned)
        const lineStart = startPos[1] - 1;
        const lineEnd = endPos[1] - 1;

        await serverManager.sendAtMention(filePath, lineStart, lineEnd);
        await commandLogger?.info(`Mentioned lines ${startPos[1]}-${endPos[1]} in ${filePath}`);

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await commandLogger?.error(`Failed to send at-mention: ${message}`);
      }
    },
    {
      range: '',
      sync: false
    }
  );
}
