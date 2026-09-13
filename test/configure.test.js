'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadConfig } = require('../src/config');
const { parseChannels, parseRelaunch, parseMod, saveConfig } = require('../src/configure');

const REPO = path.join(__dirname, '..');
const CONFIGURE = path.join(REPO, 'src', 'configure.js');

describe('configure parsers', () => {
  it('parseChannels accepts numbers, names, multis; dedupes', () => {
    assert.deepEqual(parseChannels('2'), ['ptb']);
    assert.deepEqual(parseChannels('stable,ptb'), ['stable', 'ptb']);
    assert.deepEqual(parseChannels('1, 3'), ['stable', 'canary']);
    assert.deepEqual(parseChannels('ptb,ptb'), ['ptb']);
  });

  it('parseChannels rejects non-channel names and empties', () => {
    assert.throws(() => parseChannels('beta'), /not a real channel/);
    assert.throws(() => parseChannels(''), /at least one/);
    assert.throws(() => parseChannels('5'), /not a real channel/);
  });

  it('parseMod accepts numbers and names, rejects the rest', () => {
    assert.equal(parseMod('1'), 'vencord');
    assert.equal(parseMod('2'), 'betterdiscord');
    assert.equal(parseMod('betterdiscord'), 'betterdiscord');
    assert.throws(() => parseMod('3'), /not a mod target/);
    assert.throws(() => parseMod('openasar'), /not a mod target/);
  });

  it('--mod flag is saved and read back by the trigger loader', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cfg-'));
    const p = path.join(dir, 'config.json');
    const r = spawnSync(process.execPath, [CONFIGURE, '--config', p, '--mod', 'betterdiscord'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(loadConfig(p).mod, 'betterdiscord');
  });

  it('parseRelaunch accepts y/n variants', () => {
    assert.equal(parseRelaunch('y'), true);
    assert.equal(parseRelaunch('N'), false);
    assert.equal(parseRelaunch('true'), true);
    assert.equal(parseRelaunch('0'), false);
    assert.throws(() => parseRelaunch('maybe'), /y\/n/);
  });
});

describe('configure save', () => {
  it('saveConfig writes values and preserves unknown/future keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cfg-'));
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ channels: ['stable'], someFutureKey: 42 }));
    saveConfig(p, { channels: ['ptb'], relaunchDiscord: true });
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepEqual(raw.channels, ['ptb']);
    assert.equal(raw.relaunchDiscord, true);
    assert.equal(raw.someFutureKey, 42);
    // And the trigger's loader reads the same file back.
    const cfg = loadConfig(p);
    assert.deepEqual(cfg.channels, ['ptb']);
    assert.equal(cfg.relaunchDiscord, true);
  });

  it('CLI flags mode writes the real config file the trigger reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cfg-'));
    const p = path.join(dir, 'config.json');
    const r = spawnSync(process.execPath, [CONFIGURE, '--config', p, '--channels', 'ptb', '--relaunch', 'true'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const cfg = loadConfig(p);
    assert.deepEqual(cfg.channels, ['ptb']);
    assert.equal(cfg.relaunchDiscord, true);
  });

  it('invalid channel exits nonzero and leaves the file untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-cfg-'));
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ channels: ['ptb'] }));
    const before = fs.readFileSync(p, 'utf8');
    const r = spawnSync(process.execPath, [CONFIGURE, '--config', p, '--channels', 'beta'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });
});
