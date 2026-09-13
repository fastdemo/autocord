#!/usr/bin/env node
'use strict';

/**
 * autocord — single command surface over the existing src/ logic.
 * Thin routing layer only: every subcommand delegates to the already-verified
 * implementation (src/trigger.js, src/configure.js, scripts/install.sh,
 * scripts/uninstall.sh). The exceptions are `status` (read-only report) and
 * output styling (src/ui.js) — presentation only, no behavior.
 *
 *   autocord help                              this text
 *   autocord config [--channels a,b ...]       configure (interactive or flags)
 *   autocord status                            config + agent + last patch results
 *   autocord install                           ensure installer, install agent
 *   autocord uninstall [--purge]               unload + remove plist
 *   autocord patch [--channel X] [--force] [--dry-run] [--mod M]
 *                                              run the trigger once, on demand
 *   autocord logs                              tail -f the autopatch log
 *
 * BetterDiscord is dry-run only: any patch run with that mod reports what it
 * would do and touches nothing (enforced here and in the trigger).
 *
 * A `--config <path>` flag after any subcommand overrides the config file
 * (forwarded to the underlying tool; honored via $VENCORD_AUTOPATCH_CONFIG
 * for install.sh).
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { loadConfig } = require('../src/config');
const { loadState } = require('../src/state');
const { resolveInstallerCli, ensureInstallerCli } = require('../src/installer');
const ui = require('../src/ui');

const REPO = path.join(__dirname, '..');
const TRIGGER = path.join(REPO, 'src', 'trigger.js');
const CONFIGURE = path.join(REPO, 'src', 'configure.js');
const INSTALL_SH = path.join(REPO, 'scripts', 'install.sh');
const UNINSTALL_SH = path.join(REPO, 'scripts', 'uninstall.sh');
const LABEL = 'com.vencord-autopatch';

function helpBody() {
  const cmd = (name, desc) => `  ${ui.bold(name.padEnd(11))}${ui.dim(desc)}`;
  return [`Usage: autocord <command> [options]`,
    '',
    cmd('help', 'Show this help'),
    cmd('config', 'Set channels, relaunch, mod target (interactive;'),
    `               ${ui.dim('or: --channels ptb,canary --relaunch false --mod betterdiscord)')}`,
    cmd('status', 'Show config, agent state, and last patch result per channel'),
    cmd('install', 'Set up the installer if needed, then install the LaunchAgent.'),
    `               ${ui.dim(`Run 'autocord config' first`)}`,
    cmd('uninstall', `Remove the LaunchAgent ('--purge' also removes config/state/logs)`),
    cmd('patch', 'Run a patch check once now ([--channel ptb] [--force]'),
    `               ${ui.dim('[--dry-run] [--mod vencord])')}`,
    cmd('logs', 'Follow the autopatch log (tail -f)'),
    '',
    `Fresh setup:  ${ui.mint('autocord config')}  ${ui.dim(`${ui.ARROW}`)}  ${ui.mint('autocord install')}`,
    `Later:        ${ui.mint('autocord status')}  ${ui.dim(`${ui.BULLET}`)}  ${ui.mint('autocord logs')}`,
  ].join('\n');
}

function fail(msg, code = 1) {
  process.stderr.write(`autocord: ${msg}\n`);
  process.exit(code);
}

/** Split out `--config <path>`; returns { configPath, rest }. */
function splitConfig(argv) {
  const rest = [];
  let configPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') {
      configPath = argv[++i];
      if (!configPath) fail('autocord: --config needs a path');
    } else {
      rest.push(argv[i]);
    }
  }
  return { configPath, rest };
}

/** Split out `--mod <name>`; returns { mod, rest }. */
function splitMod(argv) {
  const rest = [];
  let mod = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mod') {
      mod = argv[++i];
      if (!mod) fail('autocord: --mod needs a name (vencord, betterdiscord)');
    } else {
      rest.push(argv[i]);
    }
  }
  return { mod, rest };
}

/**
 * Decide patch mode. Pure (unit-tested): BetterDiscord always dry-runs.
 * Returns { check, dryRun, forcedForMod }.
 */
function resolvePatchMode(modName, flags) {
  const explicitDry = Boolean(flags.dryRun || flags.check);
  if (modName === 'betterdiscord') {
    return { check: true, dryRun: true, forcedForMod: !explicitDry };
  }
  return { check: explicitDry, dryRun: explicitDry, forcedForMod: false };
}

function runNode(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

function runBash(script, args, extraEnv) {
  const r = spawnSync('/bin/bash', [script, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  process.exit(r.status ?? 1);
}

function cmdHelp() {
  process.stdout.write(`${ui.appHeader('vencord')}\n\n${helpBody()}\n`);
  process.exit(0);
}

function cmdConfig(args) {
  const { configPath, rest } = splitConfig(args);
  runNode(CONFIGURE, [...(configPath ? ['--config', configPath] : []), ...rest]);
}

function effectiveMod(configPath, modFlag) {
  if (modFlag) return modFlag;
  try {
    return loadConfig(configPath).mod || 'vencord';
  } catch {
    return 'vencord';
  }
}

function cmdPatch(args) {
  const { configPath, rest: noCfg } = splitConfig(args);
  const { mod: modFlag, rest } = splitMod(noCfg);
  const dryRun = rest.includes('--dry-run');
  const check = rest.includes('--check');
  const forwarded = rest.filter((a) => a !== '--dry-run');
  const modName = effectiveMod(configPath, modFlag);
  const mode = resolvePatchMode(modName, { dryRun, check });
  if (modFlag && !['vencord', 'betterdiscord'].includes(modFlag)) {
    fail(`unknown mod '${modFlag}' (vencord, betterdiscord)`);
  }

  process.stdout.write(`${ui.appHeader(modName)}\n\n`);
  if (mode.dryRun) {
    const why = mode.forcedForMod ? 'BetterDiscord is dry-run only — nothing will be touched' : 'dry run — nothing will be touched';
    process.stdout.write(`${ui.statusLine('patch', 'yellow', `${ui.yellow('Checking (dry run)…')}  ${ui.dim(why)}`)}\n\n`);
  } else {
    process.stdout.write(`${ui.statusLine('patch', 'yellow', ui.yellow('Checking for updates…'))}\n\n`);
  }
  const finalArgs = [
    ...(configPath ? ['--config', configPath] : []),
    ...(modFlag ? ['--mod', modFlag] : []),
    ...(mode.check && !forwarded.includes('--check') ? ['--check'] : []),
    ...forwarded,
  ];
  const r = spawnSync(process.execPath, [TRIGGER, ...finalArgs], { stdio: 'inherit' });
  const code = r.status ?? 1;
  if (code === 0) {
    process.stdout.write(`\n${ui.statusLine('patch', 'green', mode.dryRun ? ui.mint('Dry run complete') : ui.mint('Finished cleanly'))}\n`);
  } else {
    process.stdout.write('\n' + ui.statusLine('patch', 'red', ui.red(`Failed (exit ${code}) — see above or run 'autocord logs'`)) + '\n');
  }
  process.exit(code);
}

function ttyPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

async function cmdInstall(args) {
  const { configPath, rest } = splitConfig(args);
  if (rest.length > 0) fail(`autocord install takes no options (got: ${rest.join(' ')}). Edit via 'autocord config' first.`);
  const cfg = loadConfig(configPath);
  if (!cfg.configExists) {
    fail(`no config at ${cfg.configPath} — run 'autocord config' first.`);
  }
  const modName = cfg.mod || 'vencord';
  process.stdout.write(`${ui.appHeader(modName)}\n\n`);
  process.stdout.write(`${ui.statusLine('setup', 'yellow', ui.yellow('Checking for updates…'))}\n`);

  // Installer CLI: found silently, else built with plain-language progress,
  // else one plain-language manual question (TTY only).
  let cliPath = resolveInstallerCli(cfg.installerCli);
  if (cliPath) {
    process.stdout.write(`          ${ui.dim(`${ui.ARROW} Found installer (auto)`)}\n`);
  }
  if (!cliPath) {
    const ensured = await ensureInstallerCli({
      explicit: explicitOverride(cfg),
      log: (m) => process.stdout.write(`          ${ui.dim(`${ui.ARROW} ${m}`)}\n`),
      prompt: process.stdin.isTTY ? ttyPrompt : null,
    });
    if (ensured.manual) {
      // Persist a manual path so future runs don't ask again.
      const { saveConfig } = require('../src/configure');
      saveConfig(cfg.configPath, { installerCli: ensured.path });
      cliPath = ensured.path;
    } else {
      cliPath = ensured.path;
    }
    if (ensured.built) {
      process.stdout.write(`          ${ui.dim(`${ui.ARROW} Built installer from source`)}\n`);
    }
    if (!cliPath) {
      process.stdout.write(`${ui.statusLine('setup', 'red', ui.red('No installer available — run `autocord install` again once you have one'))}\n`);
      process.exit(1);
    }
  }
  runBash(INSTALL_SH, [], configPath ? { VENCORD_AUTOPATCH_CONFIG: configPath } : undefined);
}

/** The config's installerCli only counts as explicit if the user set it. */
function explicitOverride(cfg) {
  try {
    const def = loadConfig('/nonexistent-autocord-probe-xyz').installerCli;
    return cfg.installerCli === def ? undefined : cfg.installerCli;
  } catch {
    return cfg.installerCli;
  }
}

function cmdUninstall(args) {
  runBash(UNINSTALL_SH, args);
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isAgentLoaded() {
  const r = spawnSync('launchctl', ['list', LABEL], { encoding: 'utf8' });
  return r.status === 0;
}

function installerBadge(cfg) {
  const found = resolveInstallerCli(cfg.installerCli);
  if (found) return { color: 'green', name: path.basename(found) };
  return { color: 'red', name: null };
}

function cmdStatus(args) {
  const { configPath, rest } = splitConfig(args);
  if (rest.length > 0) fail(`autocord status takes no options (got: ${rest.join(' ')})`);
  const cfg = loadConfig(configPath);
  const modName = cfg.mod || 'vencord';
  const { data: state } = loadState(cfg.stateFile, cfg.legacyStateFile);
  const badge = installerBadge(cfg);
  const agentOk = isAgentLoaded();

  const out = [];
  out.push(ui.appHeader(modName));
  out.push('');
  out.push(ui.kvRows([
    ['config', `${cfg.configPath}${cfg.configExists ? '' : '  (missing — run `autocord config`)'}`],
    ['channels', cfg.channels.join(', ')],
    ['relaunch', String(cfg.relaunchDiscord)],
    ['mod', modName === 'betterdiscord' ? `betterdiscord  ${ui.yellow('(dry-run mode — no files touched)')}` : modName],
  ]));
  out.push('');
  for (const ch of cfg.channels) {
    const last = (state.patched || {})[ch];
    if (last) {
      out.push(ui.statusLine(ch, 'green', `${ui.mint('Patched')}  ${ui.bold(last.version)}  ${ui.dim(`${ui.BULLET}  ${last.timestamp}`)}`));
    } else {
      out.push(ui.statusLine(ch, 'yellow', ui.yellow('No successful patch recorded yet')));
    }
  }
  out.push(ui.statusLine('installer', badge.color, badge.name ? `${ui.mint('ready')}  ${ui.sky(`(${badge.name})`)}` : ui.red('missing — run `autocord install`')));
  out.push(ui.statusLine('agent', agentOk ? 'green' : 'yellow', agentOk ? `${ui.mint('Loaded')}  ${ui.dim(`(${LABEL})`)}` : `${ui.yellow('Not loaded')}  ${ui.dim(`(run 'autocord install')`)}`));
  process.stdout.write(out.join('\n') + '\n');
}

function cmdLogs(args) {
  const { configPath, rest } = splitConfig(args);
  if (rest.length > 0) fail(`autocord logs takes no options (got: ${rest.join(' ')})`);
  const cfg = loadConfig(configPath);
  const file = path.join(cfg.logDir, 'autopatch.log');
  if (!fs.existsSync(file)) {
    fail(`no log yet at ${file} — nothing has run. Try 'autocord patch --channel <name>'.`);
  }
  const child = spawn('tail', ['-f', file], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return cmdHelp();
    case 'config':
      return cmdConfig(rest);
    case 'status':
      return cmdStatus(rest);
    case 'install':
      return cmdInstall(rest);
    case 'uninstall':
      return cmdUninstall(rest);
    case 'patch':
      return cmdPatch(rest);
    case 'logs':
      return cmdLogs(rest);
    default: {
      process.stderr.write(`autocord: unknown command '${sub}'.\n\n`);
      process.stdout.write(`${ui.appHeader('vencord')}\n\n${helpBody()}\n`);
      process.exit(2);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`autocord: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { helpBody, LABEL, resolvePatchMode, effectiveMod };
