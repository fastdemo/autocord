'use strict';

/**
 * BetterDiscord mod target. Same four-function interface as vencord.js:
 *   detect_install(channelInfo) -> installPath | null
 *   is_patched(installPath)     -> boolean
 *   patch(...) / unpatch(...)   -> { ok, output }
 *
 * Real mechanism (verified against BetterDiscord/Installer source, NOT memory):
 * - BetterDiscord does NOT swap app.asar like Vencord. inject() preserves the
 *   original as resources/betterdiscord.app.asar and drops a shadow
 *   resources/app/ folder (package.json {"main":"./index.js"} + index.js
 *   loader) that loads data/betterdiscord.asar, then requires the preserved
 *   app. Electron's app.asar would shadow app/, so the rename is required.
 *   (discord/injection.go, discord/assets/app_{index.js,package.json})
 * - IsInjected (our is_patched): resources/app/index.js AND
 *   resources/betterdiscord.app.asar both exist. The bare word
 *   "betterdiscord" inside app.asar is NOT a marker — stock Discord mentions
 *   it in Sentry denylists.
 * - detect_install accepts EITHER app.asar or betterdiscord.app.asar
 *   (mirrors upstream hasDiscordApp: an injected install has no app.asar,
 *   and must still resolve for repair/uninstall decisions).
 * - patch/unpatch shell out to the official BetterDiscord CLI
 *   (`bdcli install|uninstall`), which is fully non-interactive for these
 *   paths (cobra flags, errors returned — no prompts) and stops/restarts
 *   Discord itself. Our trigger still quits first (same as Vencord flow).
 * - bdcli channels are stable|ptb|canary only — ParseChannel silently maps
 *   anything else to stable, so our `development` channel ALWAYS uses
 *   --path <appPath> (ResolvePath accepts bundles). Never pass --channel
 *   development.
 *
 * LIVE GATING (safety): these functions execute whatever they're asked.
 * Dry-run-by-default and the --live + betterdiscordDryRun:false arming are
 * enforced in the trigger (and the `autocord patch` wrapper), never here —
 * same split as vencord.js (which never prompts because flags bypass it).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const name = 'betterdiscord';

// bdcli has no `development` channel (ParseChannel maps unknown → stable),
// so development always resolves by explicit path. Mirrors the mutual
// exclusivity in cmd/install.go and cmd/uninstall.go (--path XOR --channel).
function bdTargetArgs(channel, installPath) {
  if (channel === 'development') {
    return ['--path', installPath];
  }
  return ['--channel', channel];
}

function detect_install(channelInfo) {
  if (!channelInfo.appPath || !channelInfo.resourcesDir) return null;
  try {
    const st = fs.statSync(channelInfo.appPath);
    if (!st.isDirectory()) return null;
    const res = fs.statSync(channelInfo.resourcesDir);
    if (!res.isDirectory()) return null;
    const hasApp = fs.existsSync(path.join(channelInfo.resourcesDir, 'app.asar'));
    const hasPreserved = fs.existsSync(path.join(channelInfo.resourcesDir, 'betterdiscord.app.asar'));
    if (!hasApp && !hasPreserved) return null;
    return channelInfo.appPath;
  } catch {
    return null;
  }
}

function is_patched(installPath) {
  // Mirrors upstream IsInjected: shadow entry + preserved original.
  try {
    return (
      fs.existsSync(path.join(installPath, 'Contents', 'Resources', 'app', 'index.js')) ||
      fs.existsSync(path.join(installPath, 'resources', 'app', 'index.js'))
    ) && (
      fs.existsSync(path.join(installPath, 'Contents', 'Resources', 'betterdiscord.app.asar')) ||
      fs.existsSync(path.join(installPath, 'resources', 'betterdiscord.app.asar'))
    );
  } catch {
    return false;
  }
}

function resolveBdCli(explicit, pathEnv) {
  if (explicit && isExecutable(explicit)) return explicit;
  const dirs = (pathEnv !== undefined ? pathEnv : process.env.PATH || '').split(':');
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of ['bdcli', 'betterdiscord-cli']) {
      const full = path.join(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  for (const home of [process.env.HOME, require('os').homedir()].filter(Boolean)) {
    const full = path.join(home, 'bin', 'bdcli');
    if (isExecutable(full)) return full;
  }
  return null;
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runBdCli(cliPath, args, log) {
  log.info(`Running: ${cliPath} ${args.join(' ')}`);
  const r = spawnSync(cliPath, args, { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n').slice(-4000);
  if (r.error) {
    return { ok: false, output: `${output}\nspawn error: ${r.error.message}`.trim() };
  }
  return { ok: r.status === 0, output: output.trim() };
}

function cliOrError(config) {
  const found = resolveBdCli(config.betterdiscordCli);
  if (found) return { cli: found };
  return {
    cli: null,
    error:
      'BetterDiscord CLI (bdcli) not found on PATH. Install it:\n' +
      '  brew install betterdiscord/tap/bdcli   (macOS)' +
      '  # or: npm install -g @betterdiscord/cli',
  };
}

function patch(installPath, channel, config, log) {
  const { cli, error } = cliOrError(config || {});
  if (!cli) return { ok: false, output: error };
  const res = runBdCli(cli, ['install', ...bdTargetArgs(channel, installPath)], log);
  if (!res.ok) {
    res.output = `betterdiscord install failed (exit != 0).\n${res.output}`;
  }
  return res;
}

function unpatch(installPath, channel, config, log) {
  const { cli, error } = cliOrError(config || {});
  if (!cli) return { ok: false, output: error };
  // channel may be omitted by older callers; default to explicit path.
  const target = channel ? bdTargetArgs(channel, installPath) : ['--path', installPath];
  return runBdCli(cli, ['uninstall', ...target], log);
}

module.exports = {
  name,
  detect_install,
  is_patched,
  patch,
  unpatch,
  bdTargetArgs,
  resolveBdCli,
};
