'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bd = require('../src/mods/betterdiscord');
const { getMod, MODS } = require('../src/mods/index');

// Fake Discord bundle: tuple of which marker files exist.
function fakeApp(stockAsar, preservedAsar, loaderFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdapp-'));
  const res = path.join(dir, 'Discord PTB.app', 'Contents', 'Resources');
  fs.mkdirSync(res, { recursive: true });
  if (stockAsar) fs.writeFileSync(path.join(res, 'app.asar'), 'stock-discord-bundle');
  if (preservedAsar) fs.writeFileSync(path.join(res, 'betterdiscord.app.asar'), 'preserved-original');
  if (loaderFiles) {
    fs.mkdirSync(path.join(res, 'app'), { recursive: true });
    fs.writeFileSync(path.join(res, 'app', 'package.json'), '{"main": "./index.js"}');
    fs.writeFileSync(path.join(res, 'app', 'index.js'), 'require("../betterdiscord.app.asar")');
  }
  const appPath = path.join(dir, 'Discord PTB.app');
  return { appPath, resourcesDir: res };
}

function fakeBdCli(logFile, exitCode = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdcli-'));
  const p = path.join(dir, 'bdcli');
  fs.writeFileSync(p, `#!/bin/bash\necho "bdcli $@" >> "${logFile}"\nexit ${exitCode}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

describe('betterdiscord mod', () => {
  it('is registered alongside vencord', () => {
    assert.equal(getMod('betterdiscord').name, 'betterdiscord');
    assert.deepEqual(Object.keys(MODS).sort(), ['betterdiscord', 'vencord']);
  });

  it('detect_install resolves stock AND injected installs (mirrors hasDiscordApp)', () => {
    const stock = fakeApp(true, false, false);
    assert.equal(bd.detect_install(stock), stock.appPath);
    const injected = fakeApp(false, true, true);
    assert.equal(bd.detect_install(injected), injected.appPath);
  });

  it('detect_install returns null with neither asar present', () => {
    const bare = fakeApp(false, false, false);
    assert.equal(bd.detect_install(bare), null);
    assert.equal(bd.detect_install({ appPath: null, resourcesDir: null }), null);
  });

  it('is_patched matches IsInjected: loader entry + preserved original', () => {
    assert.equal(bd.is_patched(fakeApp(false, true, true).appPath), true);
    assert.equal(bd.is_patched(fakeApp(true, false, false).appPath), false, 'stock');
    assert.equal(bd.is_patched(fakeApp(false, true, false).appPath), false, 'preserved but no loader');
    assert.equal(bd.is_patched(fakeApp(true, false, true).appPath), false, 'loader but no preserved original');
  });

  it('is_patched is false for a Vencord stub (no BD markers)', () => {
    const vencordStub = fakeApp(true, false, false);
    assert.equal(bd.is_patched(vencordStub.appPath), false);
  });

  it('bdTargetArgs uses --channel except development, which uses --path', () => {
    assert.deepEqual(bd.bdTargetArgs('ptb', '/x.app'), ['--channel', 'ptb']);
    assert.deepEqual(bd.bdTargetArgs('stable', '/x.app'), ['--channel', 'stable']);
    assert.deepEqual(bd.bdTargetArgs('canary', '/x.app'), ['--channel', 'canary']);
    // bdcli ParseChannel maps unknown → stable, so never pass development.
    assert.deepEqual(bd.bdTargetArgs('development', '/x.app'), ['--path', '/x.app']);
  });

  it('patch shells to `bdcli install` with the right target (fake binary)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdcli-'));
    const logFile = path.join(dir, 'calls.log');
    const cli = fakeBdCli(logFile);
    const fake = fakeApp(true, false, false);
    const noopLog = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

    const r1 = bd.patch(fake.appPath, 'ptb', { betterdiscordCli: cli }, noopLog);
    assert.equal(r1.ok, true);
    assert.match(fs.readFileSync(logFile, 'utf8'), /install --channel ptb/);

    const r2 = bd.patch(fake.appPath, 'development', { betterdiscordCli: cli }, noopLog);
    assert.equal(r2.ok, true);
    assert.match(fs.readFileSync(logFile, 'utf8'), new RegExp('install --path ' + fake.appPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('patch reports bdcli failure without masking output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdcli-'));
    const cli = fakeBdCli(path.join(dir, 'calls.log'), 3);
    const fake = fakeApp(true, false, false);
    const noopLog = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
    const r = bd.patch(fake.appPath, 'ptb', { betterdiscordCli: cli }, noopLog);
    assert.equal(r.ok, false);
    assert.match(r.output, /betterdiscord install failed/);
  });

  it('unpatch shells to `bdcli uninstall`', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdcli-'));
    const logFile = path.join(dir, 'calls.log');
    const cli = fakeBdCli(logFile);
    const fake = fakeApp(false, true, true);
    const noopLog = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
    const r = bd.unpatch(fake.appPath, 'ptb', { betterdiscordCli: cli }, noopLog);
    assert.equal(r.ok, true);
    assert.match(fs.readFileSync(logFile, 'utf8'), /uninstall --channel ptb/);
  });

  it('missing bdcli explains how to install it (no auto-build)', () => {
    const fake = fakeApp(true, false, false);
    const noopLog = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
    const r = bd.patch(fake.appPath, 'ptb', { betterdiscordCli: '/nonexistent/bdcli-xyz' }, noopLog);
    assert.equal(r.ok, false);
    assert.match(r.output, /brew install betterdiscord\/tap\/bdcli/);
  });
});
