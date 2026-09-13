'use strict';

/**
 * Minimal leveled logger writing to both stderr and a rotating-ish logfile.
 * No dependencies.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function createLogger({ logDir, logLevel = 'info', logFile = 'autopatch.log' }) {
  const level = LEVELS[String(logLevel).toLowerCase()] ?? LEVELS.info;
  ensureDir(logDir);
  const file = path.join(logDir, logFile);

  function write(levelName, args) {
    if ((LEVELS[levelName] ?? 20) < level) return;
    const ts = new Date().toISOString();
    const line = `[${ts}] [${levelName.toUpperCase()}] ${args.map(stringify).join(' ')}\n`;
    try {
      fs.appendFileSync(file, line);
    } catch {
      // ignore logfile errors; still print to stderr
    }
    if (levelName === 'error' || levelName === 'warn') {
      process.stderr.write(line);
    } else if ((LEVELS[levelName] ?? 20) >= LEVELS.info) {
      process.stderr.write(line);
    }
  }

  return {
    file,
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
  };
}

function stringify(v) {
  if (v instanceof Error) return (v.stack || v.message || String(v)).split('\n').slice(0, 5).join(' | ');
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

module.exports = { createLogger, LEVELS };
