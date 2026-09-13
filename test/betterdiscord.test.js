'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bd = require('../src/mods/betterdiscord');
const { getMod, MODS } = require('../src/mods/index');

function fakeApp(dir, appAsarContent) {
  const res = path.join(dir, 'Discord PTB.app', 'Contents', 'Resources');
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, 'app.asar'), appAsarContent);
  return { appPath: path.join(dir, 'Discord PTB.app'), resourcesDir: res };
}

function fakeHomeWithLoader() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdhome-'));
  const loaderDir = path.join(home, 'Library', 'Application Support', 'BetterDiscord', 'data');
  fs.mkdirSync(loaderDir, { recursive: true });
  fs.writeFileSync(path.join(loaderDir, 'betterdiscord.asar'), 'fake-loader');
  return home;
}

describe('betterdiscord mod', () => {
  it('is registered alongside vencord', () => {
    assert.equal(getMod('betterdiscord').name, 'betterdiscord');
    assert.deepEqual(Object.keys(MODS).sort(), ['betterdiscord', 'vencord']);
  });

  it('detect_install finds a fake bundle with app.asar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdapp-'));
    const info = fakeApp(dir, 'stock-bundle-content');
    assert.equal(bd.detect_install(info), info.appPath);
  });

  it('detect_install returns null without app.asar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdapp-'));
    const res = path.join(dir, 'Discord PTB.app', 'Contents', 'Resources');
    fs.mkdirSync(res, { recursive: true });
    const info = { appPath: path.join(dir, 'Discord PTB.app'), resourcesDir: res };
    assert.equal(bd.detect_install(info), null);
    assert.equal(bd.detect_install({ appPath: null, resourcesDir: null }), null);
  });

  it('is_patched is true only with loader asar + loader marker in app.asar', () => {
    const home = fakeHomeWithLoader();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdapp-'));
    const patched = fakeApp(dir, '...require("/x/BetterDiscord/data/betterdiscord.asar")...');
    assert.equal(bd.is_patched(patched.appPath, { homeDir: home }), true);

    // Stock-like bundle: mentions BetterDiscord (Sentry-style) but NOT the loader file.
    const stock = fakeApp(fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdapp-')), 'ignoreErrors:["BetterDiscord","VencordPatcher"]');
    assert.equal(bd.is_patched(stock.appPath, { homeDir: home }), false);
  });

  it('is_patched is false without the loader asar, even with a marker', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdhome-')); // no BD data
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdapp-'));
    const info = fakeApp(dir, 'require betterdiscord.asar loader');
    assert.equal(bd.is_patched(info.appPath, { homeDir: home }), false);
  });

  it('patch/unpatch never touch files (dry-run refusal)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-bdapp-'));
    const info = fakeApp(dir, 'content');
    const target = path.join(info.resourcesDir, 'app.asar');
    const before = fs.statSync(target).mtimeMs;
    const r1 = bd.patch(info.appPath, 'ptb', {}, null);
    const r2 = bd.unpatch(info.appPath, {}, null);
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.match(r1.output, /dry-run mode/);
    assert.match(r2.output, /dry-run mode/);
    assert.equal(fs.statSync(target).mtimeMs, before, 'app.asar untouched');
    assert.ok(!fs.existsSync(path.join(info.resourcesDir, '_app.asar')), 'no backup created');
  });
});
