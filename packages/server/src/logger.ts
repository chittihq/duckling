import winston from 'winston';
import config from './config';
import * as fs from 'fs';
import * as path from 'path';

// Ensure logs directory exists in data folder
// Use absolute path that works in Docker (/app/data) and locally
const logsDir = process.env.LOGS_DIR || path.join(__dirname, '..', '..', '..', 'data', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logger = winston.createLogger({
  level: config.monitoring.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'duckdb-server' },
  transports: [
    // Error logs - separate file
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true
    }),
    // All logs
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true
    }),
    // Sync-specific logs (for debugging sync issues)
    new winston.transports.File({
      filename: path.join(logsDir, 'sync.log'),
      level: 'info',
      maxsize: 10485760, // 10MB
      maxFiles: 3,
      tailable: true,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format((info) => {
          // Only log sync-related messages
          const message = typeof info.message === 'string' ? info.message : '';
          if (
            message.includes('sync') || message.includes('Sync') ||
            message.includes('watermark') || message.includes('Appender') ||
            message.includes('Table') || message.includes('records')
          ) {
            return info;
          }
          return false;
        })(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          return `${timestamp} [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
        })
      )
    })
  ],
});

if (config.env !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Add custom method to add logs to buffer
const originalInfo = logger.info.bind(logger);
const originalError = logger.error.bind(logger);
const originalWarn = logger.warn.bind(logger);
const originalDebug = logger.debug.bind(logger);

(logger as any).info = (msg: any, ...args: any[]) => {
  originalInfo(msg, ...args);
  if ((global as any).addLogToBuffer) {
    const context = args[0] && typeof args[0] === 'object' ? JSON.stringify(args[0]) : args[0];
    (global as any).addLogToBuffer('info', msg, context);
  }
};

(logger as any).error = (msg: any, ...args: any[]) => {
  originalError(msg, ...args);
  if ((global as any).addLogToBuffer) {
    const context = args[0] && typeof args[0] === 'object' ? JSON.stringify(args[0]) : args[0];
    (global as any).addLogToBuffer('error', msg, context);
  }
};

(logger as any).warn = (msg: any, ...args: any[]) => {
  originalWarn(msg, ...args);
  if ((global as any).addLogToBuffer) {
    const context = args[0] && typeof args[0] === 'object' ? JSON.stringify(args[0]) : args[0];
    (global as any).addLogToBuffer('warn', msg, context);
  }
};

(logger as any).debug = (msg: any, ...args: any[]) => {
  originalDebug(msg, ...args);
  if ((global as any).addLogToBuffer) {
    const context = args[0] && typeof args[0] === 'object' ? JSON.stringify(args[0]) : args[0];
    (global as any).addLogToBuffer('debug', msg, context);
  }
};

export default logger;