'use strict';

/**
 * Vencord installer CLI resolution — no path questions for users.
 *
 * Order:
 *   1. Explicit config override (installerCli), if executable.
 *   2. Known build locations (where our setup puts it).
 *   3. $PATH lookup.
 *   4. One-time auto-build from source (brew install go if needed +
 *      git clone + go build --tags cli), with plain-language progress.
 *   5. Last resort: plain-language manual path prompt (empty = give up).
 *
 * exec/prompt are injectable so tests never run brew/git/go.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const INSTALLER_REPO = 'https://github.com/Vencord/Installer';
const PATH_NAMES = ['VencordInstallerCli-darwin', 'VencordInstallerCli', 'vencord-installer'];

function defaultDest(homeDir = os.homedir()) {
  return path.join(homeDir, 'bin', 'VencordInstallerCli-darwin');
}

function knownCandidates(homeDir = os.homedir()) {
  return [
    path.join(homeDir, 'bin', 'VencordInstallerCli-darwin'),
    path.join(homeDir, '.local', 'bin', 'VencordInstallerCli-darwin'),
  ];
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichIn(name, pathEnv = process.env.PATH || '') {
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const full = path.join(dir, name);
    if (isExecutable(full)) return full;
  }
  return null;
}

/** Silent resolution: explicit > known locations > $PATH. Returns path|null. */
function resolveInstallerCli(explicit, opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  if (explicit) {
    const expanded = explicit.startsWith('~/') ? path.join(homeDir, explicit.slice(2)) : explicit;
    if (isExecutable(expanded)) return expanded;
  }
  for (const c of knownCandidates(homeDir)) {
    if (isExecutable(c)) return c;
  }
  const pathEnv = opts.pathEnv !== undefined ? opts.pathEnv : process.env.PATH;
  for (const name of opts.pathNames || PATH_NAMES) {
    const found = whichIn(name, pathEnv);
    if (found) return found;
  }
  return null;
}

function defaultExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10 * 60 * 1000, ...opts });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

/**
 * Full ensure flow (async — always await). Returns { path } on success or
 * { path: null } when the user should be told plainly it couldn't be set up.
 * Never throws for expected failures (missing tools, failed build); only
 * programming errors.
 */
async function ensureInstallerCli({ explicit, dest, homeDir, pathEnv, log = () => {}, prompt = null, exec = defaultExec, skipPrereqs = false } = {}) {
  const found = resolveInstallerCli(explicit, { homeDir, pathEnv });
  if (found) return { path: found, built: false };

  log('Setting up the Vencord installer (one-time)...');
  log('This builds a small helper from source — it can take a few minutes.');

  const target = dest || defaultDest(homeDir || os.homedir());
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    log(`Couldn't create ${path.dirname(target)}: ${err.message}`);
    return manualFallback(prompt, log);
  }

  if (!skipPrereqs) {
    if (!(await commandExists('go', exec))) {
      log('Installing Go (needed to build the helper)...');
      const r = await exec('brew', ['install', 'go']);
      if (r.status !== 0 || r.error) {
        log('Automatic Go install failed.');
        return manualFallback(prompt, log);
      }
    }
    if (!(await commandExists('git', exec))) {
      log('git is required to fetch the installer source and it is missing.');
      return manualFallback(prompt, log);
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vencord-installer-'));
  try {
    log('Fetching the installer source...');
    let r = await exec('git', ['clone', '--depth', '1', INSTALLER_REPO, tmp + '/Installer']);
    if (r.status !== 0 || r.error) {
      log('Could not download the installer source (network or git issue).');
      return manualFallback(prompt, log);
    }
    log('Building the installer...');
    r = await exec('go', ['build', '-tags', 'cli', '-o', target], { cwd: tmp + '/Installer' });
    if (r.status !== 0 || r.error || !isExecutable(target)) {
      log('The build failed.');
      return manualFallback(prompt, log);
    }
    try {
      fs.chmodSync(target, 0o755);
    } catch { /* best effort */ }
    log('Installer ready.');
    return { path: target, built: true };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

async function commandExists(cmd, exec) {
  try {
    const r = await exec('which', [cmd]);
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
}

async function manualFallback(prompt, log) {
  if (!prompt) return { path: null, built: false };
  const answer = (await prompt("Couldn't build the installer automatically — do you have it somewhere already? Path (empty to skip): ") || '').trim();
  if (!answer) return { path: null, built: false };
  const expanded = answer.startsWith('~/') ? path.join(os.homedir(), answer.slice(2)) : answer;
  if (!isExecutable(expanded)) {
    log(`Nothing executable at ${expanded} — continuing without it.`);
    return { path: null, built: false };
  }
  return { path: expanded, built: false, manual: true };
}

module.exports = {
  INSTALLER_REPO,
  PATH_NAMES,
  defaultDest,
  knownCandidates,
  isExecutable,
  resolveInstallerCli,
  ensureInstallerCli,
};
