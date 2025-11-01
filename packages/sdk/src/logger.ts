/**
 * Duckling SDK Logger
 *
 * Simple logging utility for the Duckling WebSocket SDK.
 * Supports different log levels and configurable output.
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

export interface LoggerConfig {
  level: LogLevel;
  enabled: boolean;
  prefix?: string;
}

export class Logger {
  private config: LoggerConfig;
  private levelNames: Record<LogLevel, string> = {
    [LogLevel.ERROR]: 'ERROR',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.DEBUG]: 'DEBUG'
  };

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: LogLevel.INFO,
      enabled: true,
      prefix: 'DucklingSDK',
      ...config
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return this.config.enabled && level <= this.config.level;
  }

  private formatMessage(level: LogLevel, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const levelName = this.levelNames[level];
    const prefix = this.config.prefix ? `[${this.config.prefix}]` : '';
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';

    return `${timestamp} ${prefix} [${levelName}] ${message}${dataStr}`;
  }

  error(message: string, data?: any): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage(LogLevel.ERROR, message, data));
    }
  }

  warn(message: string, data?: any): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage(LogLevel.WARN, message, data));
    }
  }

  info(message: string, data?: any): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.info(this.formatMessage(LogLevel.INFO, message, data));
    }
  }

  debug(message: string, data?: any): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage(LogLevel.DEBUG, message, data));
    }
  }

  updateConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  enable(): void {
    this.config.enabled = true;
  }

  disable(): void {
    this.config.enabled = false;
  }

  /**
   * Create a child logger with additional context
   */
  child(context: string, config: Partial<LoggerConfig> = {}): Logger {
    const prefix = this.config.prefix ? `${this.config.prefix}:${context}` : context;
    return new Logger({
      ...this.config,
      prefix,
      ...config
    });
  }
}

// Default logger instance
export const logger = new Logger();