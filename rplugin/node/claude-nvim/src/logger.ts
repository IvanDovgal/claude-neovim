import { NvimPlugin } from 'neovim';

/**
 * Log levels
 */
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

/**
 * Parse log level from string
 */
function parseLogLevel(level: string | undefined): LogLevel {
  if (!level) {
    return LogLevel.INFO; // Default level
  }

  const upperLevel = level.toUpperCase();
  switch (upperLevel) {
    case 'ERROR':
      return LogLevel.ERROR;
    case 'WARN':
    case 'WARNING':
      return LogLevel.WARN;
    case 'INFO':
      return LogLevel.INFO;
    case 'DEBUG':
      return LogLevel.DEBUG;
    default:
      return LogLevel.INFO;
  }
}

/**
 * Logger class for async logging to Neovim
 */
export class Logger {
  private plugin: NvimPlugin;
  private logLevel: LogLevel;
  private prefix: string;

  constructor(plugin: NvimPlugin, prefix: string = '') {
    this.plugin = plugin;
    this.prefix = prefix;
    this.logLevel = parseLogLevel(process.env.CLAUDE_IDE_LOG_LEVEL);
  }

  /**
   * Get log level name
   */
  private getLevelName(level: LogLevel): string {
    switch (level) {
      case LogLevel.ERROR:
        return 'ERROR';
      case LogLevel.WARN:
        return 'WARN';
      case LogLevel.INFO:
        return 'INFO';
      case LogLevel.DEBUG:
        return 'DEBUG';
      default:
        return 'UNKNOWN';
    }
  }

  /**
   * Format log message
   */
  private formatMessage(level: LogLevel, message: string): string {
    const timestamp = new Date().toISOString();
    const levelName = this.getLevelName(level);
    const prefix = this.prefix ? `[${this.prefix}] ` : '';
    return `[${timestamp}] [${levelName}] ${prefix}${message}\n`;
  }

  /**
   * Write log message to Neovim
   */
  private async write(level: LogLevel, message: string): Promise<void> {
    if (level > this.logLevel) {
      return; // Skip if log level is below threshold
    }

    const formattedMessage = this.formatMessage(level, message);

    try {
      await this.plugin.nvim.outWrite(formattedMessage);
    } catch (error) {
      // Silently ignore errors when writing logs
      console.error('Failed to write log:', error);
    }
  }

  /**
   * Log error message
   */
  async error(message: string): Promise<void> {
    await this.write(LogLevel.ERROR, message);
  }

  /**
   * Log warning message
   */
  async warn(message: string): Promise<void> {
    await this.write(LogLevel.WARN, message);
  }

  /**
   * Log info message
   */
  async info(message: string): Promise<void> {
    await this.write(LogLevel.INFO, message);
  }

  /**
   * Log debug message
   */
  async debug(message: string): Promise<void> {
    await this.write(LogLevel.DEBUG, message);
  }

  /**
   * Create a child logger with additional prefix
   */
  child(childPrefix: string): Logger {
    const newPrefix = this.prefix ? `${this.prefix}:${childPrefix}` : childPrefix;
    return new Logger(this.plugin, newPrefix);
  }

  /**
   * Get current log level
   */
  getLogLevel(): LogLevel {
    return this.logLevel;
  }

  /**
   * Set log level
   */
  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }
}
