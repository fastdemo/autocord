#!/usr/bin/env node
'use strict';

/**
 * Minimal interactive configurator. Reads/writes the SAME config file the
 * trigger reads (default ~/.config/vencord-autopatch/config.json) — there is
 * exactly one config source.
 *
 * Interactive:
 *   node src/configure.js [--config <path>]
 *
 * Non-interactive (scripting; same code path, same file):
 *   node src/configure.js --channels ptb --relaunch true --mod betterdiscord
 *   node src/configure.js --channels stable,ptb --relaunch false
 *
 * Prompts (numbered, plain readline — no new dependencies):
 *   1. channels      multi-select from VALID_CHANNELS (config schema is string[])
 *   2. relaunch      y/n (config: relaunchDiscord)
 *   3. mod target    Vencord / BetterDiscord (dry-run only)
 *
 * The installer CLI path is deliberately NOT asked: it is auto-resolved
 * (known locations, then $PATH) and otherwise built from source
 * (see src/installer.js). --installer-cli remains as a manual override.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { loadConfig, expandHome, VALID_CHANNELS } = require('./config');
const { getMod } = require('./mods/index');

const CHANNEL_LIST = [...VALID_CHANNELS]; // stable, ptb, canary, development
const MOD_LIST = ['vencord', 'betterdiscord'];

function parseArgs(argv) {
  const out = { config: null, channels: undefined, relaunch: undefined, mod: undefined, installerCli: undefined };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--channels') out.channels = argv[++i];
    else if (a === '--relaunch') out.relaunch = argv[++i];
    else if (a === '--mod') out.mod = argv[++i];
    else if (a === '--installer-cli') out.installerCli = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function parseChannels(input) {
  const parts = String(input).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const picked = [];
  for (const p of parts) {
    // Accept either the number from the menu or the bare channel name.
    const byIndex = /^\d+$/.test(p) ? CHANNEL_LIST[Number(p) - 1] : null;
    const name = byIndex || p;
    if (!VALID_CHANNELS.has(name)) {
      throw new Error(`"${p}" is not a real channel name. Valid: ${CHANNEL_LIST.join(', ')}.`);
    }
    if (!picked.includes(name)) picked.push(name);
  }
  if (picked.length === 0) throw new Error('Pick at least one channel.');
  return picked;
}

function parseMod(input) {
  const v = String(input).trim().toLowerCase();
  const byIndex = /^\d+$/.test(v) ? MOD_LIST[Number(v) - 1] : null;
  const name = byIndex || v;
  try {
    getMod(name);
  } catch {
    throw new Error(`"${input}" is not a mod target. Valid: ${MOD_LIST.join(', ')} (or 1, 2).`);
  }
  return name;
}

function parseRelaunch(input) {
  const v = String(input).trim().toLowerCase();
  if (['y', 'yes', 'true', '1'].includes(v)) return true;
  if (['n', 'no', 'false', '0'].includes(v)) return false;
  throw new Error(`Answer y/n (got "${input}").`);
}

function ask(rl, state, query) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('EOF on stdin — aborted without saving.'));
    if (state.eof || rl.closed) return abort();
    rl.once('close', abort);
    rl.question(query, (ans) => {
      rl.removeListener('close', abort);
      resolve(ans);
    });
  });
}

async function interactive(existing) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const state = { eof: false };
  rl.on('close', () => { state.eof = true; });
  const prompt = (q) => ask(rl, state, q);
  const close = () => rl.close();
  try {
    console.log(`\nConfiguring ${existing.configPath}`);
    console.log(`(current: channels=${existing.channels.join(',')} relaunchDiscord=${existing.relaunchDiscord} mod=${existing.mod})\n`);

    console.log('1) Which Discord channel(s) to watch? (comma-separated numbers or names)');
    CHANNEL_LIST.forEach((c, i) => {
      const mark = existing.channels.includes(c) ? ' [current]' : '';
      console.log(`   ${i + 1}) ${c}${mark}`);
    });
    let channels;
    for (;;) {
      try {
        channels = parseChannels(await ask(rl, state, '> '));
        break;
      } catch (e) {
        if (state.eof) throw e;
        console.log(`   ${e.message}`);
      }
    }

    let relaunch;
    for (;;) {
      try {
        const def = existing.relaunchDiscord ? 'Y/n' : 'y/N';
        relaunch = parseRelaunch(await ask(rl, state, `\n2) Relaunch Discord after patching? [${def}] `) || String(existing.relaunchDiscord));
        break;
      } catch (e) {
        if (state.eof) throw e;
        console.log(`   ${e.message}`);
      }
    }

    // Mod target: real choice. BetterDiscord is dry-run only (see trigger).
    console.log('\n3) Mod target:');
    console.log(`   1) Vencord${existing.mod === 'vencord' ? ' [current]' : ''}`);
    console.log(`   2) BetterDiscord (dry-run only)${existing.mod === 'betterdiscord' ? ' [current]' : ''}`);
    let mod;
    for (;;) {
      try {
        const raw = (await ask(rl, state, '> [1] ')).trim();
        mod = parseMod(raw === '' ? existing.mod : raw);
        break;
      } catch (e) {
        if (state.eof) throw e;
        console.log(`   ${e.message}`);
      }
    }
    if (mod === 'betterdiscord') {
      console.log('   BetterDiscord runs in dry-run mode: it reports what it would do, changes nothing.');
    }

    // Hand the open session back so the caller can ask the last-resort
    // manual-path question on the same terminal if the auto-build fails.
    return { channels, relaunchDiscord: relaunch, mod, prompt, close };
  } catch (err) {
    rl.close();
    throw err;
  }
}

/** Write values into the real config file, preserving unknown/future keys. */
function saveConfig(configPath, values) {
  let raw = {};
  if (fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const next = { ...raw, ...values };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, configPath);
  return next;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: configure.js [--config <path>] [--channels <a,b>] [--relaunch <true|false>] [--mod <name>] [--installer-cli <path>]');
    console.log('  --installer-cli is a manual override; normally the installer is found/built automatically.');
    process.exit(0);
  }
  const { ensureInstallerCli } = require('./installer');
  const existing = loadConfig(args.config);
  let values;
  const nonInteractive = args.channels !== undefined || args.relaunch !== undefined || args.mod !== undefined || args.installerCli !== undefined;
  if (nonInteractive) {
    values = {};
    if (args.channels !== undefined) values.channels = parseChannels(args.channels);
    if (args.relaunch !== undefined) values.relaunchDiscord = parseRelaunch(args.relaunch);
    if (args.mod !== undefined) values.mod = parseMod(args.mod);
    if (args.installerCli !== undefined) values.installerCli = expandHome(args.installerCli);
    // Nothing else: installer resolution happens at use time
    // (autocord install builds it with progress if missing).
  } else {
    // Interactive works on a TTY and with piped answers. A closed stdin
    // aborts via the EOF guard in ask() instead of looping forever.
    const ans = await interactive(existing);
    try {
      // Installer CLI: found silently, else built with progress, else one
      // plain-language manual question — never a required config field.
      const ensured = await ensureInstallerCli({
        log: (m) => console.log(`   ${m}`),
        prompt: ans.prompt,
      });
      values = { channels: ans.channels, relaunchDiscord: ans.relaunchDiscord, mod: ans.mod };
      if (ensured.manual) values.installerCli = ensured.path;
      if (!ensured.path) {
        console.log('   Continuing without an installer — run setup again once you have one.');
      }
    } finally {
      ans.close();
    }
  }
  const saved = saveConfig(existing.configPath, values);
  console.log(`\nSaved ${existing.configPath}:`);
  const summary = { channels: saved.channels, relaunchDiscord: saved.relaunchDiscord, mod: saved.mod || 'vencord' };
  if (summary.mod === 'betterdiscord') summary.mode = 'dry-run (no files touched)';
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`configure: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseChannels, parseRelaunch, parseMod, saveConfig };
