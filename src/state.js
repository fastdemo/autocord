'use strict';

/**
 * Small JSON state store: last successfully patched version per channel.
 *
 * Shape: { version: 1, patched: { [channel]: { version, appPath, timestamp, mod } } }
 */

const fs = require('fs');
const path = require('path');

function loadState(stateFile, legacyStateFile) {
  for (const p of [stateFile, legacyStateFile].filter(Boolean)) {
    try {
      if (p && fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (data && typeof data === 'object') {
          return { data: normalize(data), loadedFrom: p };
        }
      }
    } catch {
      // fall through to empty state
    }
  }
  return { data: { version: 1, patched: {} }, loadedFrom: null };
}

function normalize(data) {
  if (!data.patched || typeof data.patched !== 'object') data.patched = {};
  if (!data.version) data.version = 1;
  return data;
}

function saveState(stateFile, data) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, stateFile);
}

module.exports = { loadState, saveState };
