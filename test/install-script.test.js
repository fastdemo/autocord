'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const INSTALL_SH = path.join(REPO, 'install.sh');

function shimDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-shim-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    fs.chmodSync(p, 0o755);
  }
  return dir;
}

function runInstall({ extraEnv = {}, shimFiles = {}, symlinks = {}, input = '' }) {
  const shim = shimDir(shimFiles);
  for (const [name, target] of Object.entries(symlinks)) {
    fs.symlinkSync(target, path.join(shim, name));
  }
  // Restricted PATH: hermetic (no real autocord/npm leak in), plus symlinks.
  const basePath = '/usr/bin:/bin:/usr/sbin:/sbin';
  return spawnSync('/bin/bash', [INSTALL_SH], {
    encoding: 'utf8',
    input,
    env: { ...process.env, PATH: `${shim}:${basePath}`, ...extraEnv },
  });
}

function realNode() {
  const r = require('child_process').spawnSync('/bin/bash', ['-c', 'command -v node'], { encoding: 'utf8' });
  return r.stdout.trim();
}

const FAKE_NPM = (log) => `#!/bin/bash\necho "npm $@" >> "${log}"\nexit \${FAKE_NPM_EXIT:-0}\n`;

describe('install.sh one-line installer', () => {
  it('uses the npm package (override honored) then warns when autocord is missing from PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-inst-'));
    const log = path.join(dir, 'npm.log');
    const r = runInstall({
      extraEnv: { AUTOCORD_NPM_PACKAGE: '/tmp/fake-pkg.tgz' },
      shimFiles: { npm: FAKE_NPM(log) },
      symlinks: { node: realNode() },
    });
    assert.equal(r.status, 1);
    assert.match(fs.readFileSync(log, 'utf8'), /install -g .*\/tmp\/fake-pkg\.tgz/);
    assert.match(r.stdout, /not on your PATH/);
  });

  it('falls back to plain instructions when there is no terminal for config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-inst-'));
    const log = path.join(dir, 'npm.log');
    const r = runInstall({
      shimFiles: { npm: FAKE_NPM(log), autocord: '#!/bin/bash\necho shim-autocord\n' },
      symlinks: { node: realNode() },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /run this yourself: autocord config/);
  });

  it('is syntactically valid bash', () => {
    const r = spawnSync('/bin/bash', ['-n', INSTALL_SH], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
});
