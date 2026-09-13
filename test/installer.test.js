'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const installer = require('../src/installer');

function fakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vap-home-'));
}

function makeBin(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'VencordInstallerCli-darwin');
  fs.writeFileSync(p, '#!/bin/sh\necho hi\n');
  fs.chmodSync(p, 0o755);
  return p;
}

describe('installer resolution', () => {
  it('known candidates include the default setup location', () => {
    assert.ok(installer.knownCandidates().includes(installer.defaultDest()));
    assert.equal(installer.defaultDest(), path.join(os.homedir(), 'bin', 'VencordInstallerCli-darwin'));
  });

  it('explicit path wins when executable, ignored when not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-inst-'));
    const good = makeBin(dir);
    assert.equal(installer.resolveInstallerCli(good, { pathEnv: '', homeDir: fakeHome() }), good);
    assert.equal(installer.resolveInstallerCli(path.join(dir, 'missing'), { pathEnv: '', homeDir: fakeHome() }), null);
  });

  it('finds the binary on $PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-inst-'));
    const p = makeBin(dir);
    assert.equal(installer.resolveInstallerCli(null, { pathEnv: dir, homeDir: fakeHome() }), p);
    assert.equal(installer.resolveInstallerCli(null, { pathEnv: '/nonexistent-dir-xyz', homeDir: fakeHome() }), null);
  });
});

describe('installer ensure flow', () => {
  it('uses an existing binary silently (no exec calls)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-inst-'));
    const good = makeBin(dir);
    let calls = 0;
    const res = await installer.ensureInstallerCli({
      explicit: good,
      homeDir: fakeHome(),
      exec: async () => { calls++; return { status: 0 }; },
    });
    assert.equal(res.path, good);
    assert.equal(res.built, false);
    assert.equal(calls, 0);
  });

  it('builds from source when missing (records the exact commands)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-inst-'));
    const dest = path.join(dir, 'out', 'VencordInstallerCli-darwin');
    const calls = [];
    const stubExec = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'which') return { status: 0 };
      if (cmd === 'git') return { status: 0 };
      if (cmd === 'go') {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'fake-binary');
        fs.chmodSync(dest, 0o755);
        return { status: 0 };
      }
      return { status: 1 };
    };
    const res = await installer.ensureInstallerCli({ dest, exec: stubExec, log: () => {}, homeDir: fakeHome(), pathEnv: '' });
    assert.equal(res.path, dest);
    assert.equal(res.built, true);
    assert.ok(calls.some((c) => c.startsWith('git clone --depth 1 https://github.com/Vencord/Installer')), JSON.stringify(calls));
    assert.ok(calls.some((c) => c.startsWith('go build -tags cli -o ' + dest)), JSON.stringify(calls));
  });

  it('failed build falls back to the plain-language manual prompt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-inst-'));
    const prompts = [];
    const stubExec = async (cmd) => {
      if (cmd === 'which') return { status: 0 };
      return { status: 1 }; // git/go fail
    };
    const res = await installer.ensureInstallerCli({
      dest: path.join(dir, 'out', 'cli'),
      exec: stubExec,
      log: () => {},
      homeDir: fakeHome(),
      pathEnv: '',
      prompt: async (q) => { prompts.push(q); return ''; },
    });
    assert.equal(res.path, null);
    assert.ok(prompts.some((q) => /Couldn't build the installer automatically/.test(q)), JSON.stringify(prompts));
  });

  it('manual path is accepted when executable, skipped when empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-inst-'));
    const good = makeBin(dir);
    const stubExec = async (cmd) => (cmd === 'which' ? { status: 0 } : { status: 1 });
    const ok = await installer.ensureInstallerCli({
      dest: path.join(dir, 'out', 'cli'),
      exec: stubExec,
      log: () => {},
      homeDir: fakeHome(),
      pathEnv: '',
      prompt: async () => good,
    });
    assert.equal(ok.path, good);
    assert.equal(ok.manual, true);
  });

  it('no prompt available means clean null (non-interactive callers fail clearly)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-inst-'));
    const stubExec = async (cmd) => (cmd === 'which' ? { status: 0 } : { status: 1 });
    const res = await installer.ensureInstallerCli({
      dest: path.join(dir, 'out', 'cli'),
      exec: stubExec,
      log: () => {},
      homeDir: fakeHome(),
      pathEnv: '',
      prompt: null,
    });
    assert.equal(res.path, null);
  });
});
