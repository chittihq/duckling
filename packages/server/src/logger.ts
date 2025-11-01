import winston from 'winston';
import config from './config';

const logger = winston.createLogger({
  level: config.monitoring.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'duckdb-server' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
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