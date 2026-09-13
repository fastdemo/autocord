'use strict';

/**
 * Config loading. No dependencies, JSON only.
 *
 * Resolved config shape:
 * {
 *   channels: string[],
 *   mod: string ('vencord' default; 'betterdiscord' = dry-run only),
 *   installerCli: string (absolute, tilde-expanded),
 *   installerMode: 'location' | 'branch',
 *   relaunchDiscord: boolean,
 *   debounceSeconds: number,
 *   debounceTimeoutSeconds: number,
 *   quitTimeoutSeconds: number,
 *   logLevel: string,
 *   stateFile: string (absolute),
 *   logDir: string (absolute),
 * }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const VALID_CHANNELS = new Set(['stable', 'ptb', 'canary', 'development']);

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultPaths() {
  const home = os.homedir();
  return {
    // Preferred state location (XDG-style). The legacy Application Support
    // path is still checked on read for backward compat.
    stateFile: path.join(home, '.local', 'share', 'vencord-autopatch', 'state.json'),
    legacyStateFile: path.join(home, 'Library', 'Application Support', 'vencord-autopatch', 'state.json'),
    logDir: path.join(home, 'Library', 'Logs', 'vencord-autopatch'),
    configFile: path.join(home, '.config', 'vencord-autopatch', 'config.json'),
  };
}

function loadConfig(cliConfigPath) {
  const defaults = defaultPaths();
  const configPath = cliConfigPath
    ? expandHome(cliConfigPath)
    : process.env.VENCORD_AUTOPATCH_CONFIG
      ? expandHome(process.env.VENCORD_AUTOPATCH_CONFIG)
      : defaults.configFile;

  let raw = {};
  if (fs.existsSync(configPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Invalid JSON in config ${configPath}: ${err.message}`);
    }
  }

  const channels = Array.isArray(raw.channels) && raw.channels.length > 0 ? raw.channels : ['stable'];
  for (const c of channels) {
    if (!VALID_CHANNELS.has(c)) {
      throw new Error(`Invalid channel "${c}". Valid: stable, ptb, canary, development.`);
    }
  }

  const installerMode = raw.installerMode || 'location';
  if (!['location', 'branch'].includes(installerMode)) {
    throw new Error(`Invalid installerMode "${installerMode}". Valid: location, branch.`);
  }

  const mod = raw.mod || 'vencord';
  try {
    require('./mods/index').getMod(mod);
  } catch {
    throw new Error(`Invalid mod "${mod}". Valid: vencord, betterdiscord.`);
  }

  // BetterDiscord live patching stays off unless explicitly armed here AND
  // requested per-run with --live. Defaults to dry-run-only.
  const betterdiscordDryRun = raw.betterdiscordDryRun === undefined ? true : raw.betterdiscordDryRun === true;
  if (typeof raw.betterdiscordDryRun !== 'undefined' && typeof raw.betterdiscordDryRun !== 'boolean') {
    throw new Error('Invalid betterdiscordDryRun: must be true or false.');
  }

  return {
    configPath,
    configExists: fs.existsSync(configPath),
    channels,
    mod,
    betterdiscordDryRun,
    installerCli: expandHome(raw.installerCli || '~/bin/VencordInstallerCli-darwin'),
    installerMode,
    relaunchDiscord: raw.relaunchDiscord === true,
    debounceSeconds: num(raw.debounceSeconds, 10),
    debounceTimeoutSeconds: num(raw.debounceTimeoutSeconds, 120),
    quitTimeoutSeconds: num(raw.quitTimeoutSeconds, 20),
    logLevel: raw.logLevel || 'info',
    stateFile: expandHome(raw.stateFile || defaults.stateFile),
    legacyStateFile: defaults.legacyStateFile,
    logDir: expandHome(raw.logDir || defaults.logDir),
  };
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

module.exports = { loadConfig, expandHome, VALID_CHANNELS };
