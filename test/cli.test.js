'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const AUTOCORD = path.join(REPO, 'bin', 'autocord.js');
const { resolvePatchMode } = require('../bin/autocord.js');

function run(...args) {
  return runEnv(args, process.env);
}

function runEnv(args, env) {
  return spawnSync(process.execPath, [AUTOCORD, ...args], { encoding: 'utf8', env });
}

function tmpConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cli-'));
  const p = path.join(dir, 'config.json');
  if (obj) fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe('autocord help', () => {
  it('lists every subcommand with one line each', () => {
    for (const args of [[], ['help']]) {
      const r = run(...args);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      for (const cmd of ['help', '--version', 'config', 'status', 'install', 'uninstall', 'patch', 'logs']) {
        assert.match(r.stdout, new RegExp(`^\\s+${cmd}\\s+\\S`, 'm'), `help mentions ${cmd}`);
      }
    }
  });

  it('unknown command prints help and exits nonzero', () => {
    const r = run('bogus');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown command/);
    assert.match(r.stdout, /Usage: autocord/);
  });

  it('--version/-v print the package version', () => {
    const expected = require('../package.json').version;
    for (const args of [['--version'], ['-v'], ['version']]) {
      const r = run(...args);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.stdout.trim(), expected);
    }
  });
});

describe('autocord status', () => {
  it('shows header box, aligned rows, no full installer path', () => {
    const p = tmpConfig({ channels: ['ptb'], relaunchDiscord: true });
    const r = run('status', '--config', p);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /╭.*╮/);
    assert.match(r.stdout, /Autocord/);
    assert.match(r.stdout, /^channels\s+ptb/m);
    assert.ok(!r.stdout.includes('/Users/khang/bin/'), 'full installer path hidden');
  });

  it('labels betterdiscord as dry-run mode', () => {
    const p = tmpConfig({ channels: ['ptb'], mod: 'betterdiscord' });
    const r = run('status', '--config', p);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /dry-run mode/);
  });

  it('reports config, agent, and patch state', () => {
    const p = tmpConfig({ channels: ['ptb'], relaunchDiscord: true });
    const r = run('status', '--config', p);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^channels\s+ptb/m);
    assert.match(r.stdout, /^relaunch\s+true/m);
    assert.match(r.stdout, /^installer\s+● (ready|missing)/m);
    assert.match(r.stdout, /^agent\s+● (Loaded|Not loaded)/m);
  });
});

describe('resolvePatchMode', () => {
  it('betterdiscord dry-runs by default, even with --force', () => {
    assert.deepEqual(resolvePatchMode('betterdiscord', {}), { check: true, dryRun: true, live: false, forcedForMod: true, refused: null });
    assert.deepEqual(resolvePatchMode('betterdiscord', { force: true }), { check: true, dryRun: true, live: false, forcedForMod: true, refused: null });
    assert.deepEqual(resolvePatchMode('betterdiscord', { dryRun: true }).forcedForMod, false);
  });

  it('betterdiscord goes live only with --live AND an armed config', () => {
    const live = resolvePatchMode('betterdiscord', { live: true }, { betterdiscordDryRun: false });
    assert.equal(live.live, true);
    assert.equal(live.check, false);
    const refused = resolvePatchMode('betterdiscord', { live: true }, {});
    assert.equal(refused.live, false);
    assert.match(refused.refused, /betterdiscordDryRun/);
  });

  it('vencord honors explicit flags only', () => {
    assert.deepEqual(resolvePatchMode('vencord', {}), { check: false, dryRun: false, live: false, forcedForMod: false, refused: null });
    assert.deepEqual(resolvePatchMode('vencord', { dryRun: true }), { check: true, dryRun: true, live: false, forcedForMod: false, refused: null });
  });
});

describe('autocord patch dry-run', () => {
  it('--dry-run reports without touching state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cli-'));
    const p = path.join(dir, 'config.json');
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(p, JSON.stringify({ channels: ['canary'], debounceSeconds: 0, logLevel: 'error', stateFile: statePath, logDir: path.join(dir, 'logs') }));
    const r = run('patch', '--config', p, '--channel', 'canary', '--dry-run');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /dry run/i);
    assert.ok(!fs.existsSync(statePath), 'dry run writes no state');
  });

  it('betterdiscord mod forces dry-run even with --force (live PTB untouched)', () => {
    const asar = '/Applications/Discord PTB.app/Contents/Resources/app.asar';
    const before = fs.existsSync(asar) ? fs.statSync(asar).mtimeMs : null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cli-'));
    const p = path.join(dir, 'config.json');
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(p, JSON.stringify({ channels: ['ptb'], mod: 'betterdiscord', debounceSeconds: 0, logLevel: 'error', stateFile: statePath, logDir: path.join(dir, 'logs') }));
    const r = run('patch', '--config', p, '--channel', 'ptb', '--force');
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /dry-run/i);
    if (before !== null) {
      assert.equal(fs.statSync(asar).mtimeMs, before, 'live app.asar untouched');
    }
    const saved = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { patched: {} };
    assert.deepEqual(saved.patched || {}, {}, 'no versions recorded');
  });
});

describe('autocord config (via wrapper)', () => {
  it('flag form writes the file the trigger reads', () => {
    const p = tmpConfig(null);
    const r = run('config', '--config', p, '--channels', 'ptb', '--relaunch', 'true');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const { loadConfig } = require('../src/config');
    const cfg = loadConfig(p);
    assert.deepEqual(cfg.channels, ['ptb']);
    assert.equal(cfg.relaunchDiscord, true);
  });
});

describe('autocord install guards', () => {
  it('refuses when no config exists yet', () => {
    const r = run('install', '--config', path.join(os.tmpdir(), 'vap-cli-nope', 'config.json'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /run 'autocord config' first/);
  });

  it('a stale explicit CLI path falls back to the auto-detected binary', () => {
    // New contract: resolution is explicit > known locations > $PATH, so a
    // dead override never blocks — status still reports ready. (Full
    // missing-binary behavior incl. auto-build is covered in installer.test.js;
    // a live `install` success path is verified manually to avoid launchd
    // side effects in the suite.)
    // Hermetic: fake installer on PATH so fallback is proven on any machine
    // (clean CI runners have no real ~/bin binary).
    const bindir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cli-'));
    fs.writeFileSync(path.join(bindir, 'VencordInstallerCli-darwin'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bindir, 'VencordInstallerCli-darwin'), 0o755);
    const p = tmpConfig({ channels: ['ptb'], installerCli: '/nonexistent/cli' });
    const r = runEnv(['status', '--config', p], { ...process.env, PATH: `${bindir}:${process.env.PATH}` });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^installer\s+● ready\s+\(VencordInstallerCli-darwin\)/m);
  });
});

describe('autocord patch (via wrapper)', () => {
  it('safe skip for a non-installed channel', () => {
    const p = tmpConfig({ channels: ['canary'], debounceSeconds: 0, logLevel: 'error' });
    const r = run('patch', '--config', p, '--channel', 'canary');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });
});

describe('autocord logs', () => {
  it('errors clearly when no log exists yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cli-'));
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ logDir: path.join(dir, 'logs') }));
    const r = run('logs', '--config', p);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no log yet/);
  });

  it('tails the resolved log file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cli-'));
    const logDir = path.join(dir, 'logs');
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(logDir, 'autopatch.log'), 'SENTINEL-LINE-123\n');
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ logDir }));
    // detached so we can kill the whole group: `autocord logs` execs a
    // `tail -f` grandchild that would otherwise outlive the wrapper.
    const child = spawn(process.execPath, [AUTOCORD, 'logs', '--config', p], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.match(out, /SENTINEL-LINE-123/);
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      await new Promise((resolve) => child.on('exit', resolve));
    }
  });
});

describe('autocord patch live gating (betterdiscord)', () => {
  it('--live without arming refuses loudly; live PTB untouched', () => {
    const asar = '/Applications/Discord PTB.app/Contents/Resources/app.asar';
    const before = fs.existsSync(asar) ? fs.statSync(asar).mtimeMs : null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cli-'));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ channels: ['ptb'], mod: 'betterdiscord', debounceSeconds: 0, logLevel: 'error', stateFile: path.join(dir, 's.json'), logDir: path.join(dir, 'logs') }));
    const r = run('patch', '--config', cfg, '--channel', 'ptb', '--live');
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr + r.stdout, /betterdiscordDryRun/);
    if (before !== null) {
      assert.equal(fs.statSync(asar).mtimeMs, before, 'live app.asar untouched');
    }
    assert.ok(!fs.existsSync(path.join(dir, 's.json')), 'no state written on refusal');
  });

  it('armed live mode delegates (canary: safe no-install path, exit 0)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cli-'));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ channels: ['canary'], mod: 'betterdiscord', betterdiscordDryRun: false, debounceSeconds: 0, logLevel: 'error', stateFile: path.join(dir, 's.json'), logDir: path.join(dir, 'logs') }));
    const r = run('patch', '--config', cfg, '--channel', 'canary', '--live');
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /LIVE BetterDiscord patch/);
  });

  it('status shows LIVE ARMED vs dry-run from config', () => {
    const armed = tmpConfig({ channels: ['ptb'], mod: 'betterdiscord', betterdiscordDryRun: false });
    const r1 = run('status', '--config', armed);
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /LIVE ARMED/);
    const dry = tmpConfig({ channels: ['ptb'], mod: 'betterdiscord' });
    const r2 = run('status', '--config', dry);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /dry-run mode/);
    assert.ok(!/LIVE ARMED/.test(r2.stdout));
  });
});
