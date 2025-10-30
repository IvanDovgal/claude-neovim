import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket } from 'ws';
import { Logger } from './logger.js';

/**
 * WebSocket Transport for MCP
 * Implements the transport interface for Claude Code WebSocket protocol
 * https://raw.githubusercontent.com/coder/claudecode.nvim/refs/heads/main/PROTOCOL.md
 */
export class WebSocketTransport implements Transport {
  private ws: WebSocket;
  private logger: Logger;
  sessionId?: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(ws: WebSocket, logger: Logger) {
    this.ws = ws;
    this.logger = logger;
  }

  /**
   * Start processing messages on the transport
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Handle connection open
      if (this.ws.readyState === WebSocket.OPEN) {
        this.setupHandlers();
        resolve();
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.once('open', () => {
          this.setupHandlers();
          resolve();
        });
        this.ws.once('error', reject);
      } else {
        reject(new Error('WebSocket is not in a valid state'));
      }
    });
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupHandlers(): void {
    // Handle incoming messages
    this.ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString('utf-8')) as JSONRPCMessage;

        // Log incoming message
        this.logger.debug(`Received: ${JSON.stringify(message)}`).catch(() => {});

        this.onmessage?.(message);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`Error parsing message: ${err.message}`).catch(() => {});
        this.onerror?.(err);
      }
    });

    // Handle connection close
    this.ws.on('close', () => {
      this.onclose?.();
    });

    // Handle errors
    this.ws.on('error', (error: Error) => {
      this.logger.error(`WebSocket error: ${error.message}`).catch(() => {});
      this.onerror?.(error);
    });
  }

  /**
   * Send a JSON-RPC message
   */
  async send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not open'));
        return;
      }

      const data = JSON.stringify(message);

      // Log outgoing message
      this.logger.debug(`Sending: ${data}`).catch(() => {});

      this.ws.send(data, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      this.ws.once('close', () => {
        resolve();
      });

      this.ws.close();
    });
  }

  /**
   * Set the protocol version (optional)
   */
  setProtocolVersion?(version: string): void {
    // Protocol version can be stored if needed
  }
}

