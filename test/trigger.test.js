'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadConfig } = require('../src/config');
const platform = require('../src/platform/darwin');
const vencord = require('../src/mods/vencord');

const REPO = path.join(__dirname, '..');
const TRIGGER = path.join(REPO, 'src', 'trigger.js');

describe('config', () => {
  it('defaults to stable channel when no config file exists', () => {
    const cfg = loadConfig('/nonexistent/path/config.json');
    assert.deepEqual(cfg.channels, ['stable']);
    assert.equal(cfg.installerMode, 'location');
    assert.equal(cfg.relaunchDiscord, false);
    assert.ok(cfg.debounceSeconds > 0);
  });

  it('rejects invalid channels', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vap-')), 'config.json');
    fs.writeFileSync(tmp, JSON.stringify({ channels: ['nope'] }));
    assert.throws(() => loadConfig(tmp), /Invalid channel/);
  });
});

describe('platform (darwin, live machine)', () => {
  it('resolves per-channel paths', () => {
    const stable = platform.getChannelInfo('stable');
    assert.equal(stable.appName, 'Discord.app');
    assert.ok(stable.supportDir.endsWith('Application Support/discord'));
    const ptb = platform.getChannelInfo('ptb');
    assert.equal(ptb.appName, 'Discord PTB.app');
    assert.ok(ptb.supportDir.endsWith('discordptb'));
  });

  it('reads live PTB version from the bundle (dev machine has 0.0.260)', () => {
    const info = platform.getChannelInfo('ptb');
    if (!info.appPath) {
      console.log('  (skip: PTB .app not installed)');
      return;
    }
    const v = platform.getCurrentVersion(info);
    assert.match(v, /^\d+\.\d+\.\d+$/);
  });

  it('vencord mod detects the live PTB install', () => {
    const info = platform.getChannelInfo('ptb');
    if (!info.appPath) {
      console.log('  (skip: PTB .app not installed)');
      return;
    }
    const installPath = vencord.detect_install(info);
    assert.equal(installPath, info.appPath);
    // is_patched mirrors upstream semantics (_app.asar marker exists).
    // State-agnostic on purpose: false before first patch, true after.
    assert.equal(typeof vencord.is_patched(installPath), 'boolean');
  });

  it('WatchPaths only includes existing paths', () => {
    const info = platform.getChannelInfo('stable');
    for (const p of platform.getWatchPaths(info)) {
      assert.ok(fs.existsSync(p), `watch path exists: ${p}`);
    }
  });
});

describe('trigger CLI', () => {
  it('--check dry-run exits 0 without writing state', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-home-'));
    const cfgPath = path.join(tmpHome, 'config.json');
    const statePath = path.join(tmpHome, 'state.json');
    const logDir = path.join(tmpHome, 'logs');
    fs.writeFileSync(cfgPath, JSON.stringify({
      channels: ['ptb'],
      installerCli: path.join(tmpHome, 'no-such-cli'),
      installerMode: 'location',
      relaunchDiscord: false,
      debounceSeconds: 0,
      logLevel: 'error',
      stateFile: statePath,
      logDir,
    }));
    const r = spawnSync(process.execPath, [TRIGGER, '--config', cfgPath, '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!fs.existsSync(statePath), 'dry run must not write state');
  });

  it('missing Discord channel exits 0 (skip, not failure)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-home-'));
    const cfgPath = path.join(tmpHome, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      channels: ['canary'],
      installerCli: path.join(tmpHome, 'no-such-cli'),
      debounceSeconds: 0,
      logLevel: 'error',
      stateFile: path.join(tmpHome, 'state.json'),
      logDir: path.join(tmpHome, 'logs'),
    }));
    const r = spawnSync(process.execPath, [TRIGGER, '--config', cfgPath], { encoding: 'utf8' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });
});
