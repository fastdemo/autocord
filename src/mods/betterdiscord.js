'use strict';

/**
 * BetterDiscord mod target. Same four-function interface as vencord.js:
 *   detect_install(channelInfo) -> installPath | null
 *   is_patched(installPath)     -> boolean
 *   patch(...) / unpatch(...)   -> { ok, output }
 *
 * Ground truth (read-only inspection of this machine):
 * - BetterDiscord keeps its loader at
 *   ~/Library/Application Support/BetterDiscord/data/betterdiscord.asar
 *   plus per-channel state dirs (data/{stable,ptb,canary,development}).
 * - Like Vencord it patches the live bundle's Resources/app.asar, so
 *   detect_install is the same shape: Discord .app present with app.asar.
 * - is_patched heuristic: the BD loader asar exists AND the live app.asar
 *   references the loader bundle name ("betterdiscord.asar"). The bare word
 *   "betterdiscord" alone is NOT enough — stock Discord app.asar mentions it
 *   in Sentry denylists (verified on the stock 3.6MB bundle).
 *
 * DRY-RUN ONLY: patch()/unpatch() never touch files; they return ok:false
 * with an explicit message. The trigger additionally forces check mode for
 * this mod, so even --force cannot live-patch until explicitly enabled.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const name = 'betterdiscord';

const DRY_RUN_NOTICE =
  'BetterDiscord live patching is not enabled (dry-run mode). ' +
  'Nothing was changed. Re-run with the Vencord target for real patching.';

function bdDataDir(homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'Application Support', 'BetterDiscord');
}

function loaderAsarPath(homeDir = os.homedir()) {
  return path.join(bdDataDir(homeDir), 'data', 'betterdiscord.asar');
}

/** Marker scanned for inside the live app.asar (case-insensitive). */
const LOADER_MARKER = 'betterdiscord.asar';
const SCAN_BYTES = 8 * 1024 * 1024;

function detect_install(channelInfo, opts = {}) {
  if (!channelInfo.appPath || !channelInfo.resourcesDir) return null;
  try {
    const st = fs.statSync(channelInfo.appPath);
    if (!st.isDirectory()) return null;
    const res = fs.statSync(channelInfo.resourcesDir);
    if (!res.isDirectory()) return null;
    if (!fs.existsSync(path.join(channelInfo.resourcesDir, 'app.asar'))) return null;
    return channelInfo.appPath;
  } catch {
    return null;
  }
}

function appAsarReferencesLoader(resourcesDir, marker = LOADER_MARKER) {
  let fd;
  try {
    fd = fs.openSync(path.join(resourcesDir, 'app.asar'), 'r');
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, SCAN_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8').toLowerCase().includes(marker.toLowerCase());
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch { /* ignore */ }
    }
  }
}

function is_patched(installPath, opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  try {
    if (!fs.existsSync(loaderAsarPath(homeDir))) return false;
    return appAsarReferencesLoader(path.join(installPath, 'Contents', 'Resources'));
  } catch {
    return false;
  }
}

function patch() {
  return { ok: false, output: DRY_RUN_NOTICE };
}

function unpatch() {
  return { ok: false, output: DRY_RUN_NOTICE };
}

module.exports = {
  name,
  detect_install,
  is_patched,
  patch,
  unpatch,
  DRY_RUN_NOTICE,
  LOADER_MARKER,
  bdDataDir,
  loaderAsarPath,
};
