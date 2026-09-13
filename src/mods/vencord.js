'use strict';

/**
 * Vencord mod target (pluggable interface).
 *
 * Interface every mod target implements (keep it to these four so adding
 * BetterDiscord later means one new file under src/mods/, not touching core):
 *   name
 *   detect_install(channelInfo) -> installPath | null
 *   is_patched(installPath)     -> boolean
 *   patch(installPath, channel, config, log) -> { ok, output }
 *   unpatch(installPath, config, log)        -> { ok, output }
 *
 * Non-interactive strategy (verified against Installer source, cli.go):
 * the CLI's PromptDiscord() is skipped entirely when --location or --branch
 * is given, so unattended runs never block on promptui. Default is
 * --location <appPath> (most explicit); --branch <channel> is the fallback.
 * Flag spelling is single-dash (-install, --location both accepted by Go flag).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const name = 'vencord';

function detect_install(channelInfo) {
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

function is_patched(installPath) {
  // Mirrors upstream semantics (_app.asar marker exists) on both layouts:
  // - macOS: installPath is Discord.app, marker at Contents/Resources/_app.asar
  //   (see find_discord_darwin.go ParseDiscord).
  // - Windows: installPath is the versioned app-<ver> dir, marker at
  //   resources/_app.asar (see find_discord_windows.go ParseDiscord).
  // Interface unchanged; the mod tolerates both patch layouts.
  try {
    if (fs.existsSync(path.join(installPath, 'Contents', 'Resources', '_app.asar'))) return true;
    if (fs.existsSync(path.join(installPath, 'resources', '_app.asar'))) return true;
    return false;
  } catch {
    return false;
  }
}

function runInstaller(cliPath, args, log) {
  log.info(`Running: ${cliPath} ${args.join(' ')}`);
  const r = spawnSync(cliPath, args, { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n').slice(-4000);
  if (r.error) {
    return { ok: false, output: `${output}\nspawn error: ${r.error.message}`.trim() };
  }
  return { ok: r.status === 0, output: output.trim() };
}

function patch(installPath, channel, config, log) {
  if (!fs.existsSync(config.installerCli)) {
    return {
      ok: false,
      output: `Installer CLI not found at ${config.installerCli}. Build it: brew install go; git clone https://github.com/Vencord/Installer; cd Installer && go build -tags cli -o VencordInstallerCli-darwin`,
    };
  }
  const args =
    config.installerMode === 'branch'
      ? ['-install', '--branch', channel]
      : ['-install', '--location', installPath];
  const res = runInstaller(config.installerCli, args, log);
  if (!res.ok) {
    res.output = `vencord -install failed (exit != 0).\n${res.output}`;
  }
  return res;
}

function unpatch(installPath, config, log) {
  if (!fs.existsSync(config.installerCli)) {
    return { ok: false, output: `Installer CLI not found at ${config.installerCli}` };
  }
  const args =
    config.installerMode === 'branch'
      ? ['-uninstall', '--branch', installPath]
      : ['-uninstall', '--location', installPath];
  return runInstaller(config.installerCli, args, log);
}

module.exports = { name, detect_install, is_patched, patch, unpatch };
