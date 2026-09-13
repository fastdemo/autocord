'use strict';

/**
 * macOS platform layer. All OS-specific path/process knowledge lives here so a
 * future Windows port swaps this file instead of rewriting the core loop.
 *
 * Ground truth (verified on dev machine, PTB 0.0.260):
 * - Live patch target: /Applications/<App>.app/Contents/Resources/app.asar
 *   (patched marker: sibling _app.asar). Vencord's ParseDiscord() on darwin
 *   resolves exactly this layout (find_discord_darwin.go).
 * - ~/Library/Application Support/discord<channel>/app-<ver>/modules/... holds ONLY
 *   native modules, not app.asar. A bare `<ver>` dir may also exist (empty).
 * - macOS updates stage under Application Support then ShipIt moves the new
 *   bundle over /Applications/*.app (see ShipIt_request.json:
 *   updateBundleURL=.../app-0.0.260/Discord PTB.app -> target=/Applications/...).
 *   So /Applications/*.app IS replaced on update: watch BOTH locations.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CHANNELS = {
  stable: {
    appName: 'Discord.app',
    supportDirName: 'discord',
    processNames: ['Discord'],
    bundleId: 'com.hnc.Discord',
  },
  ptb: {
    appName: 'Discord PTB.app',
    supportDirName: 'discordptb',
    processNames: ['Discord PTB'],
    bundleId: 'com.hnc.DiscordPTB',
  },
  canary: {
    appName: 'Discord Canary.app',
    supportDirName: 'discordcanary',
    processNames: ['Discord Canary'],
    bundleId: 'com.hnc.DiscordCanary',
  },
  development: {
    appName: 'Discord Development.app',
    supportDirName: 'discorddevelopment',
    processNames: ['Discord Development'],
    bundleId: 'com.hnc.DiscordDevelopment',
  },
};

const APP_BASES = ['/Applications', path.join(os.homedir(), 'Applications')];

function getChannelInfo(channel) {
  const def = CHANNELS[channel];
  if (!def) throw new Error(`Unknown channel: ${channel}`);
  const home = os.homedir();
  let appPath = null;
  for (const base of APP_BASES) {
    const candidate = path.join(base, def.appName);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        appPath = candidate;
        break;
      }
    } catch {
      // ignore
    }
  }
  return {
    channel,
    ...def,
    appPath, // may be null if not installed
    supportDir: path.join(home, 'Library', 'Application Support', def.supportDirName),
    resourcesDir: appPath ? path.join(appPath, 'Contents', 'Resources') : null,
  };
}

/** Best-effort current Discord version for a channel. Returns string|null. */
function getCurrentVersion(info) {
  // 1. build_info.json inside the live bundle (most authoritative for host).
  if (info.resourcesDir) {
    try {
      const raw = fs.readFileSync(path.join(info.resourcesDir, 'build_info.json'), 'utf8');
      const v = JSON.parse(raw).version;
      if (typeof v === 'string' && v) return v;
    } catch {
      // fall through
    }
    // 2. Info.plist CFBundleShortVersionString
    try {
      const plist = fs.readFileSync(path.join(info.appPath, 'Contents', 'Info.plist'), 'utf8');
      const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
      if (m) return m[1].trim();
    } catch {
      // fall through
    }
  }
  // 3. Newest app-<ver> dir under Application Support (module staging).
  try {
    const entries = fs.readdirSync(info.supportDir, { withFileTypes: true });
    const versions = entries
      .filter((e) => e.isDirectory() && /^app-\d+\.\d+\.\d+$/.test(e.name))
      .map((e) => e.name.slice(4))
      .sort(compareVersions);
    if (versions.length > 0) return versions[versions.length - 1];
  } catch {
    // support dir may not exist
  }
  return null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Paths launchd should watch for this channel (only ones that exist). */
function getWatchPaths(info) {
  const paths = [];
  if (info.appPath && fs.existsSync(info.appPath)) {
    // Watching the bundle dir catches ShipIt replacing the .app on update.
    // (WatchPaths is recursive on macOS — verified empirically.)
    paths.push(info.appPath);
  }
  try {
    if (fs.existsSync(info.supportDir) && fs.statSync(info.supportDir).isDirectory()) {
      paths.push(info.supportDir);
    }
  } catch {
    // ignore
  }
  return paths;
}

function isDiscordRunning(info) {
  for (const name of info.processNames) {
    // pgrep -x matches exact process name; Discord's main process is e.g. "Discord PTB".
    const r = spawnSync('pgrep', ['-x', name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return true;
  }
  return false;
}

function quitDiscord(info, timeoutSeconds, log) {
  for (const name of info.processNames) {
    try {
      execFileSync('osascript', ['-e', `tell application "${name}" to quit`], { timeout: 10000 });
      log && log.info(`Asked ${name} to quit via osascript`);
    } catch (err) {
      log && log.debug(`osascript quit for ${name} failed (may not be running):`, err.message);
    }
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (!isDiscordRunning(info)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  // Graceful quit timed out: force-kill remaining helpers, then re-check.
  for (const name of info.processNames) {
    try {
      execFileSync('pkill', ['-x', name]);
    } catch {
      // pkill exits 1 when nothing matched — fine
    }
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  return !isDiscordRunning(info);
}

function relaunchDiscord(info, log) {
  if (!info.appPath) throw new Error(`Cannot relaunch ${info.channel}: app not found`);
  const r = spawnSync('open', ['-a', info.appPath], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`open -a failed: ${(r.stderr || r.error || '').toString().trim()}`);
  }
  log && log.info(`Relaunched ${info.appName}`);
}

/** Max mtime (ms) under given paths; used for debounce quiescence checks. */
function maxMtimeMs(paths) {
  let max = 0;
  const stack = [...paths];
  const seen = new Set();
  while (stack.length > 0) {
    const p = stack.pop();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs > max) max = st.mtimeMs;
    if (st.isDirectory()) {
      let entries;
      try {
        entries = fs.readdirSync(p);
      } catch {
        continue;
      }
      // Skip heavy/noisy subtrees that never signal version changes.
      for (const e of entries) {
        if (e === 'Cache' || e === 'Code Cache' || e === 'GPUCache' || e === 'Crashpad') continue;
        stack.push(path.join(p, e));
      }
    }
    // Safety valve against pathological trees.
    if (seen.size > 20000) break;
  }
  return max;
}

function sendNotification(title, message) {
  const text = `${title}: ${message}`.slice(0, 500);
  // Prefer terminal-notifier if installed, else osascript.
  try {
    const r = spawnSync('which', ['terminal-notifier'], { encoding: 'utf8' });
    if (r.status === 0) {
      spawnSync('terminal-notifier', ['-title', title, '-message', message]);
      return;
    }
  } catch {
    // fall through
  }
  try {
    execFileSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]);
  } catch {
    // notifications are best-effort
  }
}

module.exports = {
  CHANNELS,
  getChannelInfo,
  getCurrentVersion,
  getWatchPaths,
  isDiscordRunning,
  quitDiscord,
  relaunchDiscord,
  maxMtimeMs,
  sendNotification,
};
