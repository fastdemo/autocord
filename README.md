# vencord-autopatch

Background tool for macOS that detects a Discord update and automatically
re-patches Vencord — no manual re-install after every Discord auto-update.

Scope: **macOS + Vencord only**, with two deliberate extension hooks
(mod target + platform layer) so BetterDiscord support and a Windows port
are easy to bolt on later.

## How it works

1. A `launchd` LaunchAgent (`~/Library/LaunchAgents/com.vencord-autopatch.plist`)
   uses `WatchPaths` on the Discord support dir(s) and the live `.app`
   bundle(s), so the OS wakes the trigger on changes instead of polling.
2. The trigger (`src/trigger.js`, plain Node, zero dependencies):
   - **Debounces** — waits until no mtime changes under watch paths for
     `debounceSeconds` (Discord writes many files over a few seconds).
   - Detects the current version per channel and compares it against the
     last successfully patched version in the state file (**idempotent** —
     unchanged versions are skipped).
   - Quits Discord gracefully if running, runs the Vencord installer CLI,
     updates state, optionally relaunches, logs everything, and sends a
     macOS notification on failure.

## Validation findings (dev machine, please read)

These were verified on the dev machine before coding, and the design
depends on them:

- **Patch target is the `.app` bundle, not the version folders.**
  Live code: `/Applications/Discord*.app/Contents/Resources/app.asar`
  (patched marker: sibling `_app.asar` — same semantics as upstream
  `ParseDiscord()` in `find_discord_darwin.go`).
  `~/Library/Application Support/discord*/app-<ver>/modules/` holds **only
  native modules**, not `app.asar`. The task brief's claim that
  `/Applications/Discord.app` "does not get replaced on every update" is
  **wrong on macOS**: updates stage under `Application Support` and ShipIt
  moves the new bundle over `/Applications/*.app` (see
  `ShipIt_request.json`: `updateBundleURL=.../app-0.0.260/Discord PTB.app`
  → `targetBundleURL=file:///Applications/Discord%20PTB.app/`).
  **Therefore the agent watches BOTH locations.**
- **No prompt hack needed.** The CLI's `PromptDiscord()` is skipped entirely
  when `--location` or `--branch` is passed (verified in `cli.go`). Default
  is `--location <appPath>` (most explicit); `--branch` is configurable.
- **No prebuilt macOS CLI exists.** Releases ship a macOS GUI `.app` plus
  Linux/Windows CLIs only. You must `brew install go` and
  `go build -tags cli` (see Setup). This is the biggest setup cost.
- **`WatchPaths` fires recursively** (verified: deep writes trigger), but
  the default 10s `ThrottleInterval` coalesces rapid updates (verified) —
  the plist sets `ThrottleInterval=0` and debouncing lives in the trigger.
- **Dev machine state:** only Discord **PTB 0.0.260** is installed
  (`/Applications/Discord PTB.app`); the stable support dir exists but is
  nearly empty and no stable `.app` is installed. Default config is
  `["stable"]` per spec — end-to-end testing on *this* machine needs
  `["ptb"]`. The install is currently **unpatched** (stock 5-file
  `app.asar`; the `vencord` strings inside are Discord's Sentry denylist,
  not a patch).

## Setup

Prerequisites: macOS (Windows port in progress — see below), Node.js 18+.

**Easiest — one line, no dev setup assumed:**

```bash
curl -fsSL https://raw.githubusercontent.com/fastdemo/autocord/main/install.sh | bash
# checks Node (auto-installs via Homebrew on macOS, otherwise links you to
# nodejs.org), installs the CLI, and walks straight into `autocord config`.
# Then: autocord install
```

**Or straight from npm** (needs Node 18+ already):

```bash
npm install -g autocord-cli
autocord config     # prompts: channels, relaunch, mod target
autocord install    # sets up the installer if needed, then the LaunchAgent
```

> Status: `autocord-cli` is new — if `npm install -g autocord-cli` 404s,
> the package hasn't been published yet; use the one-liner above (it falls
> back to a source install automatically) or build from source below.

**From source** (contributors / fallback):

```bash
git clone https://github.com/fastdemo/autocord && cd autocord
npm install -g .
autocord config && autocord install   # re-run install after config edits
```
```

Day to day:

```bash
autocord status     # config + agent loaded? + last patch result per channel
autocord logs       # follow the autopatch log
autocord help       # all commands, one line each
```

## Configuration

`~/.config/vencord-autopatch/config.json` — the single config source. Either
`autocord config` or hand-edit it (same file, no second source):

```bash
autocord config                          # numbered prompts
autocord config --config <path>          # alternate file (also honored
                                         # via $VENCORD_AUTOPATCH_CONFIG)
# Non-interactive (same code path, same file — good for scripting):
autocord config --channels ptb --relaunch true --mod vencord
autocord config --channels stable,ptb --relaunch false --mod betterdiscord
```

Prompts: 1) channel multi-select (`stable`/`ptb`/`canary`/`development`,
numbers or names, comma-separated — matches the `channels: string[]`
schema), 2) relaunch y/n, 3) mod target — Vencord, or BetterDiscord
(**dry-run only**: reports what it would do, never touches files).
Unknown/future keys in the file are preserved on save.

No installer-path question: the CLI is auto-resolved (explicit override,
then the standard build location `~/bin/VencordInstallerCli-darwin`, then
`$PATH`). If none is found, `autocord config` / `autocord install` builds it
from source automatically ("Setting up the Vencord installer (one-time)…");
only if that build fails are you asked for a path in plain language.
`--installer-cli` remains as a manual override.

| Key | Default | Meaning |
|---|---|---|
| `channels` | `["stable"]` | Which builds to watch: `stable`, `ptb`, `canary`, `development` |
| `mod` | `"vencord"` | Mod target: `vencord` (live patching) or `betterdiscord` (**dry-run only** — detect + report, never patch) |
| `installerCli` | `~/bin/VencordInstallerCli-darwin` | Manual override; normally auto-resolved (known locations → `$PATH` → auto-build from source) |
| `installerMode` | `"location"` | `"location"` → `-install --location <appPath>`; `"branch"` → `-install --branch <channel>` |
| `relaunchDiscord` | `false` | If true **and** Discord was running before patching, relaunch it after success |
| `debounceSeconds` | `10` | Quiet period before acting |
| `debounceTimeoutSeconds` | `120` | Give up waiting for quiet and proceed |
| `quitTimeoutSeconds` | `20` | Graceful-quit wait before `pkill` |
| `logLevel` | `"info"` | `debug`, `info`, `warn`, `error` |
| `stateFile` | `~/.local/share/vencord-autopatch/state.json` | Last patched versions (legacy `~/Library/Application Support/vencord-autopatch/state.json` still read) |
| `logDir` | `~/Library/Logs/vencord-autopatch` | Log destination |

Channel → paths mapping (`src/platform/darwin.js`):

| Channel | .app | Support dir |
|---|---|---|
| `stable` | `Discord.app` | `.../Application Support/discord` |
| `ptb` | `Discord PTB.app` | `.../discordptb` |
| `canary` | `Discord Canary.app` | `.../discordcanary` |
| `development` | `Discord Development.app` | `.../discorddevelopment` |

## Checking on it

```bash
autocord status     # config + agent loaded? + last patch result per channel
autocord logs       # follow the log (tail -f, Ctrl-C to stop)
autocord patch --dry-run --channel ptb   # full detect→decide, touches nothing
```

Sample `autocord status` (monochrome plain-text output):

```
╭────────────────────────────────╮
│  Autocord (@fastdemo)          │
│  macOS · Vencord Auto-Patcher  │
╰────────────────────────────────╯

config    /Users/khang/.config/vencord-autopatch/config.json
channels  ptb
relaunch  true
mod       vencord

ptb        ● Patched  0.0.260  ·  2026-09-13T06:15:52.197Z
installer  ● ready (VencordInstallerCli-darwin)
agent      ● Not loaded  (run 'autocord install')
```

With `mod: betterdiscord` the header reads `macOS · BetterDiscord ·
dry-run mode`, status labels the mod row `(dry-run mode — no files
touched)`, and every `patch` run is a dry run (even `--force`).

Bump-test (fires the agent within seconds; watch `autocord logs` for a run):

```bash
touch "$HOME/Library/Application Support/discord"
```

## Manual / advanced usage (same tools `autocord` wraps)

```bash
# Config file directly (what 'autocord config' writes):
node src/configure.js --channels ptb --relaunch true

# Trigger directly (what 'autocord patch' runs):
node src/trigger.js --check --channel ptb   # dry run: no changes, no state write
node src/trigger.js --force                  # real re-patch (quits Discord if running!)

# Agent plumbing:
launchctl list com.vencord-autopatch
plutil -p ~/Library/LaunchAgents/com.vencord-autopatch.plist  # inspect WatchPaths
tail -f ~/Library/Logs/vencord-autopatch/launchd.stderr.log
bash scripts/install.sh    # what 'autocord install' runs (re-run after config edits
                           # to regenerate WatchPaths)
bash scripts/uninstall.sh  # what 'autocord uninstall' runs (--purge for everything)
```

State file shape (`state.json`):

```json
{ "version": 1, "patched": { "stable": {
  "version": "0.0.3xx", "appPath": "/Applications/Discord.app",
  "timestamp": "2026-09-13T...", "mod": "vencord" } } }
```

## Windows port (in progress)

`src/platform/win32.js` implements the same interface as `darwin.js`
(selected automatically in `src/platform/index.js`), so the trigger loop
and mods are shared. Grounded in the Vencord Installer's own
`find_discord_windows.go`:

- Installs live at `%LOCALAPPDATA%\<Discord|DiscordPTB|DiscordCanary|DiscordDevelopment>\app-<ver>\resources\app.asar`
  (patch marker: sibling `_app.asar`; newest `app-*` wins).
- The Go CLI's `-install --location/--branch` flags are shared
  cross-platform code (`cli.go`), so installer parity holds.
- **Scheduler instead of launchd:** Task Scheduler has no filesystem-watch
  trigger (`ONEVENT` only subscribes to Event Log channels), so Windows
  polls — `schtasks /create /sc MINUTE /mo 30 /tn "Autocord Patch Check"`
  running `node <repo>\src\trigger.js --config <config>` — which is correct
  because the trigger is idempotent via the state file. See
  `buildPollingTaskArgs()` for the exact command shape.

Still needs one confirmation run on a real Windows box before calling it
done: graceful `taskkill` behavior, `Update.exe --processStart` relaunch,
and the WinRT toast notification (`sendNotification`). No Windows machine
or VM was available for this pass — see the `DOCS-UNTESTED` markers in
`src/platform/win32.js` for the exact list.

## Tests

```bash
npm test   # node --test, no dependencies; includes live-machine checks
```

## File layout

```
bin/autocord.js           single CLI (help/config/status/install/uninstall/patch/logs)
src/ui.js                 terminal styling: header box, ● dots, aligned columns (no deps)
src/installer.js          installer CLI auto-resolve + one-time source build + manual fallback
src/trigger.js            launchd entrypoint (debouce → detect → quit → patch → state)
src/configure.js          interactive/flags configurator (writes the real config.json)
src/config.js             config load + defaults + validation
src/state.js              state file load/save (idempotency)
src/logger.js             leveled file+stderr logger
src/platform/darwin.js    PLATFORM LAYER: .app/support paths, version detect,
                          running/quit/relaunch, WatchPaths, notifications
src/mods/vencord.js       MOD TARGET: detect_install/is_patched/patch/unpatch
src/mods/betterdiscord.js MOD TARGET (dry-run only): same interface, patch/unpatch refuse
src/mods/index.js         mod registry (add a file + require line for future mods)
launchd/*.plist.sample    sample plist (install.sh generates the real one)
scripts/install.sh        generate plist from config + launchctl load
scripts/uninstall.sh      unload + remove plist (--purge for config/state/logs)
config.sample.json        documented default config
test/trigger.test.js      unit + live-machine + dry-run tests
```

## Extensibility (hooks, not frameworks)

- **New mod (BetterDiscord):** write `src/mods/betterdiscord.js` exporting
  `{ name, detect_install, is_patched, patch, unpatch }`, require it in
  `src/mods/index.js`, run with `trigger.js --mod betterdiscord`.
  Nothing in the watcher core changes.
- **New OS (Windows):** add `src/platform/win32.js` with the same function
  names as `darwin.js` (`getChannelInfo`, `getCurrentVersion`,
  `getWatchPaths`, `isDiscordRunning`, `quitDiscord`, `relaunchDiscord`,
  `maxMtimeMs`, `sendNotification`) and branch on `process.platform` in
  `trigger.js`. Core loop stays untouched.

## Known limitations

- **Requires building the Go CLI yourself** (no upstream macOS CLI binary).
  Until `installerCli` exists and is executable, every run fails loudly
  (log + notification) by design.
- **Discord must be quit to patch.** The trigger quits it via AppleScript
  (`tell application ... to quit`) with a `pkill` fallback. Unsaved state
  (e.g. an un-sent message draft) could be lost — same as manual patching.
- **Relaunch is opt-in** (`relaunchDiscord=false` default): after an
  unattended update Discord stays quit unless you enable it.
- **No code signature handling.** Replacing `app.asar` inside a signed
  `.app` works (Vencord's standard method), but a future Discord change to
  integrity checks could break patching until the upstream installer adapts.
- **Stable-only default.** Only the configured `channels` are watched;
  running an unconfigured branch (e.g. Canary while only `stable` is set)
  will never be patched. Re-run `install.sh` after changing channels.
- **Single-flight lock, no queue.** Overlapping launchd wakes exit early;
  the next wake (or `RunAtLoad` on login) picks up missed work via the
  state file rather than queuing.
- **Notifications are best-effort** (`terminal-notifier` if present, else
  `osascript`); failures are always in the log even if the popup fails.
```

