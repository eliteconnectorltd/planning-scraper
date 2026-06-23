'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOGS_ROOT = path.join(__dirname, '..', '..', 'logs');

function createTraceId(prefix = 'trace') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

class Logger {
  constructor(context = {}) {
    this.context = { ...context };
    const today = new Date().toISOString().slice(0, 10);
    this.logsDir = path.join(LOGS_ROOT, today);
    this.logFile = path.join(this.logsDir, 'structured.log');
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  child(extraContext = {}) {
    return new Logger({ ...this.context, ...extraContext });
  }

  write(level, message, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...details,
    };

    const line = JSON.stringify(entry);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }

    try {
      fs.appendFileSync(this.logFile, `${line}\n`, 'utf8');
    } catch (err) {
      console.error(`Failed writing structured log: ${err.message}`);
    }
  }

  debug(message, details) { this.write('debug', message, details); }
  info(message, details) { this.write('info', message, details); }
  warn(message, details) { this.write('warn', message, details); }
  error(message, details) { this.write('error', message, details); }
}

const defaultLogger = new Logger({ trace_id: createTraceId('run') });

module.exports = {
  Logger,
  createTraceId,
  logger: defaultLogger,
};
