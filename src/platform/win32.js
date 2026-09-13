'use strict';

/**
 * Windows platform layer. Same interface as darwin.js so mods
 * (src/mods/vencord.js) and the trigger loop work unchanged — only this
 * file (selected via src/platform/index.js) differs per OS.
 *
 * Provenance of every Windows fact (no Windows machine was available, so
 * each item is marked):
 *
 * [VALIDATED-SOURCE] Discord layout + patched marker, from the Vencord
 *   Installer's own find_discord_windows.go (the tool our trigger shells
 *   out to, so matching its semantics is load-bearing):
 *   %LOCALAPPDATA%\<Discord|DiscordPTB|DiscordCanary|DiscordDevelopment>\
 *     app-<major>.<minor>.<patch>\resources\app.asar
 *   patched marker: sibling resources\_app.asar. Newest install = the
 *   lexicographically largest app-* dir (upstream compares full paths with
 *   `>`; we sort numerically, which agrees for equal-length versions and
 *   is strictly more correct otherwise).
 * [VALIDATED-SOURCE] CLI parity: cli.go (PromptDiscord --location/--branch
 *   bypass) is shared cross-platform code, so -install flags behave the
 *   same on Windows. Note upstream's Windows PreparePatch SIGKILLs
 *   Discord itself; we still quit gracefully first (taskkill without /F,
 *   then /F fallback), matching our macOS design.
 * [VALIDATED-DOCS] Scheduler: schtasks has NO filesystem-watch trigger —
 *   ONEVENT subscribes to Event Log channels only (/ec), and NTFS changes
 *   are not logged by default (Microsoft Learn: schtasks-create). So the
 *   Windows counterpart to WatchPaths is polling: `schtasks /create
 *   /sc MINUTE /mo 30`, which is correct BECAUSE the trigger is idempotent
 *   (state file skip). See buildPollingTaskArgs() + README "Windows" section.
 * [DOCS-UNTESTED] Relaunch via Squirrel's Update.exe:
 *   %LOCALAPPDATA%\<Dir>\Update.exe --processStart <Exe>.exe, falling back
 *   to the newest app-*\Discord.exe. Standard Squirrel.Windows convention
 *   (Discord shortcuts target Update.exe); NOT confirmed on a live box.
 * [DOCS-UNTESTED] Notifications via in-box PowerShell WinRT toast API
 *   (Windows.UI.Notifications, present since Windows 8/10) — chosen over
 *   node-notifier to keep zero runtime dependencies, and over BurntToast
 *   (external module, may not be installed). NOT executed here.
 * [DOCS-UNTESTED] taskkill /IM graceful-then-/F, tasklist CSV parsing.
 *
 * Anything tagged DOCS-UNTESTED needs one confirmation run on a real
 * Windows box before the Windows path is called done.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const winjoin = path.win32.join;

// [VALIDATED-SOURCE] find_discord_windows.go windowsNames.
const CHANNELS = {
  stable: {
    dirName: 'Discord',
    exeName: 'Discord.exe',
    processNames: ['Discord.exe'],
  },
  ptb: {
    dirName: 'DiscordPTB',
    exeName: 'DiscordPTB.exe',
    processNames: ['DiscordPTB.exe'],
  },
  canary: {
    dirName: 'DiscordCanary',
    exeName: 'DiscordCanary.exe',
    processNames: ['DiscordCanary.exe'],
  },
  development: {
    dirName: 'DiscordDevelopment',
    exeName: 'DiscordDevelopment.exe',
    processNames: ['DiscordDevelopment.exe'],
  },
};

const TASK_NAME = 'Autocord Patch Check';
const POLL_MINUTES = 30;

function localAppData() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  // Fallback mirroring %USERPROFILE%\AppData\Local.
  const home = process.env.USERPROFILE || os.homedir();
  return winjoin(home, 'AppData', 'Local');
}

/** Newest app-<x.y.z> dir under versionsRoot (numeric version sort). */
function newestAppDir(versionsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(versionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((e) => e.isDirectory() && /^app-\d+\.\d+\.\d+$/.test(e.name))
    .map((e) => e.name)
    .sort(compareAppDirs);
  if (versions.length === 0) return null;
  return versions[versions.length - 1];
}

function compareAppDirs(a, b) {
  const pa = a.slice(4).split('.').map(Number);
  const pb = b.slice(4).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function getChannelInfo(channel) {
  const def = CHANNELS[channel];
  if (!def) throw new Error(`Unknown channel: ${channel}`);
  const supportDir = winjoin(localAppData(), def.dirName);
  const newest = newestAppDir(supportDir);
  const appPath = newest ? winjoin(supportDir, newest) : null;
  return {
    channel,
    ...def,
    supportDir, // == versionsRoot on Windows (%LOCALAPPDATA%\<Dir>)
    versionsRoot: supportDir,
    appPath, // snapshot of newest app-* at call time (re-resolve per run)
    resourcesDir: appPath ? winjoin(appPath, 'resources') : null,
  };
}

/** Best-effort current Discord version: newest app-<ver> dir name. */
function getCurrentVersion(info) {
  const newest = newestAppDir(info.versionsRoot || info.supportDir);
  return newest ? newest.slice(4) : null;
}

/**
 * Watch candidates for debounce purposes. NOTE: unlike launchd WatchPaths
 * these are NOT os-monitored — the Windows design polls (see
 * buildPollingTaskArgs), and the trigger's debounce scans these paths for
 * quiescence the same way.
 */
function getWatchPaths(info) {
  const paths = [];
  try {
    if (fs.existsSync(info.supportDir) && fs.statSync(info.supportDir).isDirectory()) {
      paths.push(info.supportDir);
    }
  } catch {
    // ignore
  }
  return paths;
}

/** [DOCS-UNTESTED] tasklist CSV parse for an exact image name. */
function isDiscordRunning(info) {
  for (const name of info.processNames) {
    const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.trim().split('\n')[0] || '';
      // CSV row looks like: "Discord.exe","1234",... — "No tasks" info means absent.
      if (first.toLowerCase().startsWith(`"${name.toLowerCase()}"`)) return true;
    }
  }
  return false;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * [DOCS-UNTESTED] Graceful taskkill first, /F fallback after timeout.
 * Returns true when no matching process remains.
 */
function quitDiscord(info, timeoutSeconds, log) {
  for (const name of info.processNames) {
    try {
      execFileSync('taskkill', ['/IM', name], { timeout: 10000 });
      log && log.info(`Asked ${name} to quit via taskkill`);
    } catch (err) {
      log && log.debug(`taskkill for ${name} failed (may not be running):`, err.message);
    }
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (!isDiscordRunning(info)) return true;
    sleepMs(500);
  }
  for (const name of info.processNames) {
    try {
      execFileSync('taskkill', ['/F', '/IM', name]);
    } catch {
      // already gone — fine
    }
  }
  sleepMs(1000);
  return !isDiscordRunning(info);
}

/**
 * [DOCS-UNTESTED] Squirrel Update.exe --processStart, falling back to the
 * newest app dir's exe directly.
 */
function relaunchDiscord(info, log) {
  const updater = winjoin(info.supportDir, 'Update.exe');
  const exeArg = info.exeName.replace(/\.exe$/i, '');
  let lastErr = null;
  if (fs.existsSync(updater)) {
    const r = spawnSync(updater, ['--processStart', exeArg], { encoding: 'utf8' });
    if (r.status === 0) {
      log && log.info(`Relaunched via Update.exe --processStart ${exeArg}`);
      return;
    }
    lastErr = new Error((r.stderr || `exit ${r.status}`).toString().trim());
  }
  const newest = newestAppDir(info.supportDir);
  if (newest) {
    const direct = winjoin(info.supportDir, newest, info.exeName);
    const r = spawnSync(direct, [], { encoding: 'utf8' });
    if (r.status === 0) {
      log && log.info(`Relaunched via ${direct}`);
      return;
    }
    lastErr = new Error((r.stderr || `exit ${r.status}`).toString().trim());
  }
  throw lastErr || new Error(`Cannot relaunch ${info.channel}: no Update.exe or app exe found`);
}

/** Max mtime (ms) under given paths; debounce quiescence check (mirrors darwin). */
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
      for (const e of entries) {
        stack.push(winjoin(p, e));
      }
    }
    if (seen.size > 20000) break;
  }
  return max;
}

/** PowerShell source for an in-box WinRT toast. [DOCS-UNTESTED] */
function toastScript(title, message) {
  const esc = (s) => String(s).replace(/'/g, "''").replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&(?!(lt|gt|amp);)/g, '&amp;');
  return (
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;` +
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;` +
    `$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>${esc(title)}</text><text>${esc(message)}</text></binding></visual></toast>");` +
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Autocord').Show($xml);`
  );
}

/** PowerShell one-liner args for an in-box WinRT toast. [DOCS-UNTESTED] */
function buildToastArgs(title, message) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', toastScript(title, message)];
}

/** [DOCS-UNTESTED] Best-effort notification; never throws. */
function sendNotification(title, message) {
  try {
    spawnSync('powershell', buildToastArgs(title, message), { encoding: 'utf8', timeout: 15000 });
  } catch {
    // notifications are best-effort
  }
}

/**
 * schtasks args for the polling design (primary Windows mechanism).
 * Runs `node <trigger> --config <config>` every POLL_MINUTES + at logon
 * catch-up is inherent (missed updates are detected via the state file).
 * Pure + unit-tested; creating the task itself needs an admin-or-user
 * shell on the box: schtasks /create ... (see README Windows section).
 */
function buildPollingTaskArgs({ nodeExe, triggerJs, configPath, taskName = TASK_NAME, minutes = POLL_MINUTES }) {
  const tr = `"${nodeExe}" "${triggerJs}" --config "${configPath}"`;
  return {
    create: ['/create', '/sc', 'MINUTE', '/mo', String(minutes), '/tn', taskName, '/tr', tr, '/f'],
    query: ['/query', '/tn', taskName],
    delete: ['/delete', '/tn', taskName, '/f'],
  };
}

module.exports = {
  CHANNELS,
  TASK_NAME,
  POLL_MINUTES,
  localAppData,
  newestAppDir,
  getChannelInfo,
  getCurrentVersion,
  getWatchPaths,
  isDiscordRunning,
  quitDiscord,
  relaunchDiscord,
  maxMtimeMs,
  buildToastArgs,
  toastScript,
  sendNotification,
  buildPollingTaskArgs,
};
