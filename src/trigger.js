#!/usr/bin/env node
'use strict';

/**
 * vencord-autopatch trigger: run by launchd on WatchPaths events.
 *
 * Flow per channel:
 *   1. Debounce: wait until no mtime changes under watch paths for N seconds.
 *   2. Detect install + current version; compare with state file (idempotent skip).
 *   3. Skip if version unchanged AND is_patched().
 *   4. Quit Discord gracefully if running; run installer CLI; update state;
 *      optionally relaunch; log everything; notify on failure.
 *
 * Usage:
 *   trigger.js [--config <path>] [--force] [--check|--dry-run] [--channel <name>] [--mod <name>]
 *     --force    ignore state file, re-patch even if version unchanged
 *     --check    dry run: report what WOULD be done, change nothing
 *                (--dry-run is an alias; also forced for betterdiscord)
 *     --channel  limit to one channel (default: all configured)
 *     --mod      mod target (default: config `mod`, else vencord)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { loadState, saveState } = require('./state');
const platform = require('./platform/index').default; // darwin vs win32 swap point
const { getMod } = require('./mods/index');

function parseArgs(argv) {
  const out = { config: null, force: false, check: false, channel: null, mod: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--check' || a === '--dry-run') out.check = true;
    else if (a === '--channel') out.channel = argv[++i];
    else if (a === '--mod') out.mod = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Single-flight lock so overlapping launchd wakes don't patch concurrently.
function acquireLock(lockFile) {
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, `${process.pid}\n`);
    return {
      fd,
      release() {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockFile);
        } catch {}
      },
    };
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Stale lock? If PID is dead, take over.
      try {
        const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
        if (pid && !isPidAlive(pid)) {
          fs.unlinkSync(lockFile);
          return acquireLock(lockFile);
        }
      } catch {}
      return null;
    }
    throw err;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForQuiescence(watchPaths, debounceSeconds, timeoutSeconds, log) {
  if (debounceSeconds <= 0 || watchPaths.length === 0) return;
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const latest = platform.maxMtimeMs(watchPaths);
    const ageSec = (Date.now() - latest) / 1000;
    if (ageSec >= debounceSeconds) {
      log.debug(`Quiescent: newest mtime ${ageSec.toFixed(1)}s ago`);
      return;
    }
    if (Date.now() >= deadline) {
      log.warn(`Debounce timeout (${timeoutSeconds}s) reached; proceeding anyway`);
      return;
    }
    const waitMs = Math.min((debounceSeconds - ageSec) * 1000 + 250, 5000);
    log.info(`Waiting for quiet period (${ageSec.toFixed(1)}s < ${debounceSeconds}s), sleeping ${(waitMs / 1000).toFixed(1)}s...`);
    sleep(waitMs);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: trigger.js [--config <path>] [--force] [--check] [--channel <name>] [--mod <name>]');
    process.exit(0);
  }

  const config = loadConfig(args.config);
  const log = createLogger({ logDir: config.logDir, logLevel: config.logLevel });
  const mod = getMod(args.mod || config.mod || 'vencord');
  if (mod.name === 'betterdiscord' && !args.check) {
    // Safety net (the `autocord patch` wrapper also enforces this):
    // BetterDiscord is dry-run only until explicitly enabled.
    log.warn('BetterDiscord target is dry-run only — forcing check mode (no files will be touched)');
    args.check = true;
  }
  const lockFile = path.join(path.dirname(config.stateFile), '.autopatch.lock');

  log.info(`=== autopatch run (mod=${mod.name}, channels=${args.channel || config.channels.join(',')}) ===`);
  if (!config.configExists) {
    log.warn(`Config not found at ${config.configPath}; using defaults (stable, no relaunch)`);
  }

  const lock = acquireLock(lockFile);
  if (!lock) {
    log.info('Another autopatch run is in progress; exiting');
    process.exit(0);
  }

  let exitCode = 0;
  try {
    const { data: state } = loadState(config.stateFile, config.legacyStateFile);
    const channels = args.channel ? [args.channel] : config.channels;

    // Collect watch paths across channels for a single debounce wait.
    const allWatchPaths = [];
    const infos = {};
    for (const ch of channels) {
      const info = platform.getChannelInfo(ch);
      infos[ch] = info;
      allWatchPaths.push(...platform.getWatchPaths(info));
    }

    if (!args.check) {
      waitForQuiescence(allWatchPaths, config.debounceSeconds, config.debounceTimeoutSeconds, log);
    }

    for (const ch of channels) {
      try {
        const code = processChannel(ch, infos[ch], { config, log, mod, state, force: args.force, check: args.check });
        if (code !== 0) exitCode = code;
      } catch (err) {
        exitCode = 1;
        log.error(`Channel ${ch} failed:`, err);
        platform.sendNotification('Vencord Autopatch failed', `${ch}: ${err.message}`);
      }
    }

    if (!args.check) {
      saveState(config.stateFile, state);
    }
  } finally {
    lock.release();
  }
  log.info(`=== run finished (exit=${exitCode}) ===`);
  process.exit(exitCode);
}

function processChannel(channel, info, { config, log, mod, state, force, check }) {
  const installPath = mod.detect_install(info);
  if (!installPath) {
    log.info(`[${channel}] No Discord install found (looked for ${info.appName}); skipping`);
    return 0;
  }
  const version = platform.getCurrentVersion(info);
  if (!version) {
    log.warn(`[${channel}] Install found at ${installPath} but version undetectable; skipping`);
    return 0;
  }
  const patched = mod.is_patched(installPath);
  const last = state.patched[channel];
  log.info(`[${channel}] version=${version} patched=${patched} lastPatched=${last ? last.version : '(none)'}`);

  if (!force && last && last.version === version && patched) {
    log.info(`[${channel}] Unchanged since last successful patch; nothing to do`);
    return 0;
  }
  if (!force && last && last.version === version && !patched && last.mod === mod.name) {
    // Edge: state claims patched but marker missing (user uninstalled mod?) — re-patch.
    log.info(`[${channel}] State claims ${version} patched but marker missing; re-patching`);
  }

  if (check) {
    log.info(`[${channel}] --check: would ${patched ? 'repair' : 'install'} ${mod.name} on ${version} at ${installPath}`);
    return 0;
  }

  const wasRunning = platform.isDiscordRunning(info);
  log.info(`[${channel}] Discord running: ${wasRunning}`);
  if (wasRunning) {
    log.info(`[${channel}] Quitting Discord before patch...`);
    const quit = platform.quitDiscord(info, config.quitTimeoutSeconds, log);
    if (!quit) {
      const msg = 'Could not quit Discord; refusing to patch a running install';
      log.error(`[${channel}] ${msg}`);
      platform.sendNotification('Vencord Autopatch failed', `[${channel}] ${msg}`);
      return 1;
    }
  }

  log.info(`[${channel}] Patching ${mod.name} (attempt version=${version} path=${installPath})...`);
  const res = mod.patch(installPath, channel, config, log);
  if (res.output) log.info(`[${channel}] installer output:\n${res.output}`);
  if (!res.ok) {
    log.error(`[${channel}] Patch FAILED for version ${version}`);
    platform.sendNotification('Vencord Autopatch failed', `[${channel}] patch failed for ${version}; see logs`);
    // Best effort: relaunch if we quit it, so the user isn't left without Discord.
    if (wasRunning && config.relaunchDiscord) {
      try {
        platform.relaunchDiscord(info, log);
      } catch (e) {
        log.warn(`[${channel}] relaunch after failure failed:`, e.message);
      }
    }
    return 1;
  }

  // Verify marker appeared; installer claims success but double-check.
  const nowPatched = mod.is_patched(installPath);
  if (!nowPatched) {
    log.warn(`[${channel}] Installer exited 0 but _app.asar marker missing; treating as failure`);
    platform.sendNotification('Vencord Autopatch failed', `[${channel}] installer succeeded but patch marker missing`);
    return 1;
  }

  state.patched[channel] = {
    version,
    appPath: installPath,
    timestamp: new Date().toISOString(),
    mod: mod.name,
  };
  log.info(`[${channel}] SUCCESS: patched ${version} (success/failure/version logged here)`);

  if (wasRunning && config.relaunchDiscord) {
    try {
      platform.relaunchDiscord(info, log);
    } catch (e) {
      log.warn(`[${channel}] relaunch failed:`, e.message);
    }
  } else if (wasRunning) {
    log.info(`[${channel}] Not relaunching (relaunchDiscord=false)`);
  }
  return 0;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`fatal: ${err.stack || err.message}\n`);
    try {
      const config = loadConfig(null);
      platform.sendNotification('Vencord Autopatch failed', String(err.message).slice(0, 200));
    } catch {}
    process.exit(1);
  }
}

module.exports = { main: main, parseArgs: parseArgs };
