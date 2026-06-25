'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeStringify } = require('./utils');

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const DEFAULT_LOG_BUFFER_LIMIT = 600;
const LOG_FILE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const LOG_FILE_ROTATE_MS = 24 * 60 * 60 * 1000;

function formatArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'object' && arg !== null) return safeStringify(arg, 2000);
  return String(arg);
}

function createLogger(scope = 'app', sharedOnceKeys = new Set(), sharedLines = [], sharedFileState = null) {
  const fileState = sharedFileState || createLogFileState();

  function write(level, args) {
    const normalized = LEVELS.has(level) ? level : 'info';
    const line = [
      new Date().toISOString(),
      normalized.toUpperCase().padEnd(5),
      `[${scope}]`,
      args.map(formatArg).join(' ')
    ].join(' ');
    sharedLines.push({ at: Date.now(), level: normalized, scope, line });
    if (sharedLines.length > DEFAULT_LOG_BUFFER_LIMIT) {
      sharedLines.splice(0, sharedLines.length - DEFAULT_LOG_BUFFER_LIMIT);
    }
    writeLogFile(fileState, line);
    const target = normalized === 'error' ? console.error : normalized === 'warn' ? console.warn : console.log;
    target(line);
  }

  return {
    scope,
    child(childScope) {
      return createLogger(`${scope}:${childScope}`, sharedOnceKeys, sharedLines, fileState);
    },
    getLines(options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit) || 80));
      const scopePrefix = String(options.scopePrefix || '');
      const contains = String(options.contains || '').toLowerCase();
      return sharedLines
        .filter((entry) => {
          if (scopePrefix && !String(entry.scope || '').startsWith(scopePrefix)) return false;
          if (contains && !String(entry.line || '').toLowerCase().includes(contains)) return false;
          return true;
        })
        .slice(-limit);
    },
    debug(...args) {
      write('debug', args);
    },
    info(...args) {
      write('info', args);
    },
    warn(...args) {
      write('warn', args);
    },
    error(...args) {
      write('error', args);
    },
    once(key, level, ...args) {
      const onceKey = `${scope}:${key}`;
      if (sharedOnceKeys.has(onceKey)) return;
      sharedOnceKeys.add(onceKey);
      write(level, args);
    }
  };
}

function createLogFileState() {
  const state = {
    dir: path.join(process.cwd(), 'logs', 'script'),
    startedAt: 0,
    filePath: '',
    lastPruneAt: 0
  };
  rotateLogFile(state);
  pruneOldLogFiles(state);
  return state;
}

function writeLogFile(state, line) {
  try {
    if (!state.filePath || Date.now() - state.startedAt >= LOG_FILE_ROTATE_MS) rotateLogFile(state);
    if (Date.now() - state.lastPruneAt >= 60 * 60 * 1000) pruneOldLogFiles(state);
    fs.appendFileSync(state.filePath, `${line}\n`);
  } catch (error) {
    const target = console.warn || console.log;
    target(`Logger file write failed: ${error.message || error}`);
  }
}

function rotateLogFile(state) {
  fs.mkdirSync(state.dir, { recursive: true });
  state.startedAt = Date.now();
  state.filePath = path.join(state.dir, `script-${safeTimestamp(new Date(state.startedAt))}.log`);
}

function pruneOldLogFiles(state) {
  state.lastPruneAt = Date.now();
  try {
    fs.mkdirSync(state.dir, { recursive: true });
    const cutoff = Date.now() - LOG_FILE_MAX_AGE_MS;
    for (const name of fs.readdirSync(state.dir)) {
      if (!/^script-.+\.log$/i.test(name)) continue;
      const filePath = path.join(state.dir, name);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
    }
  } catch (error) {
    const target = console.warn || console.log;
    target(`Logger prune failed: ${error.message || error}`);
  }
}

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

module.exports = {
  createLogger
};
