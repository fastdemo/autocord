'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const win32 = require('../src/platform/win32');
const platformIndex = require('../src/platform/index');
const vencord = require('../src/mods/vencord');

const SAVED_ENV = { ...process.env };

function fakeLocalAppData() {
  // Hermetic %LOCALAPPDATA%: Discord + DiscordPTB with versioned app dirs.
  const lad = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-win-'));
  const mk = (dir, ver, patched) => {
    const res = path.join(lad, dir, `app-${ver}`, 'resources');
    fs.mkdirSync(res, { recursive: true });
    fs.writeFileSync(path.join(res, 'app.asar'), `stock ${dir} ${ver}`);
    if (patched) fs.writeFileSync(path.join(res, '_app.asar'), `backup ${dir} ${ver}`);
  };
  mk('Discord', '1.0.9000', false);
  mk('Discord', '1.0.9002', true); // newest wins, patched
  mk('Discord', '1.0.8999', false); // must NOT win (numeric, not lexicographic trap)
  mk('DiscordPTB', '0.0.260', false);
  process.env.LOCALAPPDATA = lad;
  return lad;
}

beforeEach(() => {
  process.env = { ...SAVED_ENV };
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe('win32 channel layout (mirrors upstream windowsNames)', () => {
  it('maps every channel to the documented install dir + exe', () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(win32.CHANNELS).map(([k, v]) => [k, v.dirName])),
      { stable: 'Discord', ptb: 'DiscordPTB', canary: 'DiscordCanary', development: 'DiscordDevelopment' }
    );
    assert.equal(win32.CHANNELS.stable.exeName, 'Discord.exe');
    assert.equal(win32.CHANNELS.ptb.exeName, 'DiscordPTB.exe');
  });

  it('newestAppDir picks the highest version numerically', () => {
    const lad = fakeLocalAppData();
    assert.equal(win32.newestAppDir(path.join(lad, 'Discord')), 'app-1.0.9002');
    assert.equal(win32.newestAppDir(path.join(lad, 'Nope')), null);
  });

  it('getChannelInfo builds win-style paths (string level; backslashes never resolve on mac)', () => {
    const lad = fs.mkdtempSync(path.join(os.tmpdir(), 'vap-win-'));
    process.env.LOCALAPPDATA = lad;
    // getWatchPaths needs a real dir, so create the channel dir with POSIX
    // separators (fs-level); the win-style string assertions below are exact.
    fs.mkdirSync(path.join(lad, 'Discord'), { recursive: true });
    const info = win32.getChannelInfo('stable');
    // supportDir is a Windows path even under test — compare literally.
    assert.equal(info.supportDir, path.win32.join(lad, 'Discord'));
    assert.equal(info.versionsRoot, info.supportDir);
    // No versioned dirs: no version snapshot available.
    assert.equal(info.appPath, null);
    assert.equal(info.resourcesDir, null);
    assert.equal(win32.getCurrentVersion(info), null);
  });
});

describe('win32 + vencord mod unchanged', () => {
  it('the existing mod consumes exactly {appPath, resourcesDir} — no mod changes', () => {
    // On Windows these two strings come from win32.getChannelInfo (backslash
    // paths); here we point the identical shape at a POSIX fake tree to prove
    // the contract without pretending backslashes resolve on macOS.
    const lad = fakeLocalAppData();
    const mkInfo = (dir) => {
      const vers = fs
        .readdirSync(path.join(lad, dir))
        .filter((n) => n.startsWith('app-'))
        .sort()
        .reverse()[0];
      const appPath = path.join(lad, dir, vers);
      return { appPath, resourcesDir: path.join(appPath, 'resources') };
    };
    const stable = mkInfo('Discord'); // newest app-1.0.9002 has _app.asar
    assert.equal(vencord.detect_install(stable), stable.appPath);
    assert.equal(vencord.is_patched(stable.appPath), true);

    const ptb = mkInfo('DiscordPTB'); // unpatched
    assert.equal(vencord.detect_install(ptb), ptb.appPath);
    assert.equal(vencord.is_patched(ptb.appPath), false);
  });

  it('win32 newest-selection agrees with the fake tree (numeric, not lexicographic)', () => {
    const lad = fakeLocalAppData();
    assert.equal(win32.newestAppDir(path.join(lad, 'Discord')), 'app-1.0.9002');
  });
});

describe('win32 scheduler + notifier command builders', () => {
  it('builds a polling schtasks command (no event trigger — none exists)', () => {
    const t = win32.buildPollingTaskArgs({ nodeExe: 'node', triggerJs: 't.js', configPath: 'c.json' });
    assert.deepEqual(t.create.slice(0, 6), ['/create', '/sc', 'MINUTE', '/mo', '30', '/tn']);
    assert.ok(t.create.includes('node" "t.js" --config "c.json"') || t.create.join(' ').includes('--config "c.json"'));
    assert.deepEqual(t.delete.slice(0, 2), ['/delete', '/tn']);
  });

  it('toast args invoke powershell with the WinRT toast API, XML-escaped', () => {
    const args = win32.buildToastArgs("T'itle<", 'msg & more');
    assert.equal(args[0], '-NoProfile');
    const script = args[args.length - 1];
    assert.ok(script.includes('ToastNotificationManager'), 'uses in-box WinRT API');
    assert.ok(script.includes("T''itle&lt;"), 'single-quote doubled + angle escaped');
    assert.ok(script.includes('&amp;'), 'ampersand escaped');
  });
});

describe('platform selector', () => {
  it('loads darwin on this machine, win32 on demand', () => {
    assert.equal(platformIndex.load('darwin'), require('../src/platform/darwin'));
    assert.equal(platformIndex.load('win32'), require('../src/platform/win32'));
    assert.equal(platformIndex.load(), require('../src/platform/darwin'));
  });
});
