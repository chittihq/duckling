import logger from '../logger';

interface LogEntry {
  id: number;
  timestamp: number;
  level: string;
  message: string;
  context?: string;
}

export class LogBufferService {
  private logs: LogEntry[] = [];
  private nextId: number = 1;
  private static instance: LogBufferService;

  private constructor() {}

  static getInstance(): LogBufferService {
    if (!LogBufferService.instance) {
      LogBufferService.instance = new LogBufferService();
    }
    return LogBufferService.instance;
  }

  /**
   * Initialize log buffering by creating a global log function
   */
  initialize(): void {
    // Create a global log function that can be called from anywhere
    (global as any).addLogToBuffer = (level: string, message: any, context?: any) => {
      this.addLog(level, message, context);
    };

    // Add a test log to verify initialization
    this.addLog('info', 'Log buffer service initialized');
  }

  /**
   * Add a log entry to the buffer
   */
  addLog(level: string, message: any, context?: any): void {
    let processedContext: string | undefined;

    if (context !== null && context !== undefined) {
      if (typeof context === 'string') {
        processedContext = context;
      } else if (typeof context === 'object') {
        try {
          processedContext = JSON.stringify(context);
        } catch (error) {
          processedContext = `[Object: ${context.constructor?.name || 'Unknown'}]`;
        }
      } else {
        processedContext = String(context);
      }
    }

    const logEntry: LogEntry = {
      id: this.nextId++,
      timestamp: Date.now(),
      level: level.toLowerCase(),
      message: typeof message === 'string' ? message : JSON.stringify(message),
      context: processedContext
    };

    this.logs.push(logEntry);

    // Keep only last 10000 logs in memory
    if (this.logs.length > 10000) {
      this.logs = this.logs.slice(-10000);
    }
  }

  
  /**
   * Get logs since a specific ID, filtered by levels
   */
  getLogs(sinceId: number = 0, levels?: string[]): LogEntry[] {
    let filteredLogs = this.logs.filter(log => log.id > sinceId);

    if (levels && levels.length > 0) {
      const normalizedLevels = levels.map(level => level.toLowerCase());
      filteredLogs = filteredLogs.filter(log => normalizedLevels.includes(log.level));
    }

    // Return newest logs first (limit to 1000 per request)
    return filteredLogs.slice(-1000);
  }

  /**
   * Get recent logs (last 1000)
   */
  getRecentLogs(levels?: string[]): LogEntry[] {
    let recentLogs = this.logs.slice(-1000);

    if (levels && levels.length > 0) {
      const normalizedLevels = levels.map(level => level.toLowerCase());
      recentLogs = recentLogs.filter(log => normalizedLevels.includes(log.level));
    }

    return recentLogs;
  }

  /**
   * Clear all logs from buffer
   */
  clearLogs(): void {
    this.logs = [];
    this.nextId = 1;
    logger.info('Log buffer cleared');
  }

  /**
   * Get buffer statistics
   */
  getStats() {
    return {
      totalLogs: this.logs.length,
      nextId: this.nextId,
      oldestLog: this.logs.length > 0 ? this.logs[0].timestamp : null,
      newestLog: this.logs.length > 0 ? this.logs[this.logs.length - 1].timestamp : null
    };
  }
}

export default LogBufferService;