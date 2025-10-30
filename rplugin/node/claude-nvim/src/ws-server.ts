import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Lock file format for Claude Code authentication
 */
interface LockFile {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: 'ws';
  authToken: string;
}

/**
 * Configuration for Claude WebSocket Server
 */
interface ClaudeWebSocketServerConfig {
  port: number;
  path?: string;
  workspaceFolders?: string[];
  ideName?: string;
}

/**
 * Creates a Claude Code WebSocket Server with authentication
 * Implements the authentication protocol from:
 * https://raw.githubusercontent.com/coder/claudecode.nvim/refs/heads/main/PROTOCOL.md
 *
 * @param config - Server configuration
 * @returns WebSocketServer instance
 *
 * @example
 * ```typescript
 * const server = createClaudeWebSocketServer({ port: 45678, path: '/claude' });
 *
 * await server.start();
 *
 * server.on('connection', (client) => {
 *   console.log('Client connected');
 *   client.on('message', (data) => {
 *     console.log('Received:', data.toString());
 *   });
 * });
 *
 * // Later...
 * await server.stop();
 * ```
 */
export function createClaudeWebSocketServer(
  config: ClaudeWebSocketServerConfig
): WebSocketServer {
  const port = config.port;
  const path = config.path || '/';
  const workspaceFolders = config.workspaceFolders || [process.cwd()];
  const ideName = config.ideName || 'neovim';

  // Generate authentication token
  const authToken = randomUUID();

  // Lock file path: ~/.claude/ide/[port].lock
  const claudeDir = join(homedir(), '.claude', 'ide');
  const lockFilePath = join(claudeDir, `${port}.lock`);

  // Create lock file directory if it doesn't exist
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Create lock file with authentication token
  const lockData: LockFile = {
    pid: process.pid,
    workspaceFolders,
    ideName,
    transport: 'ws',
    authToken
  };

  writeFileSync(lockFilePath, JSON.stringify(lockData, null, 2), 'utf-8');

  // Create WebSocket server bound to localhost only
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    path,
    verifyClient: (info, callback) => {
      // Verify authentication token from header
      const authHeader = info.req.headers['x-claude-code-ide-authorization'];

      if (authHeader === authToken) {
        callback(true);
      } else {
        callback(false, 401, 'Unauthorized');
      }
    }
  });

  // Register cleanup on server close
  wss.on('close', () => {
    try {
      if (existsSync(lockFilePath)) {
        unlinkSync(lockFilePath);
      }
    } catch (error) {
      // Ignore errors during cleanup
    }
  });

  return wss;
}
