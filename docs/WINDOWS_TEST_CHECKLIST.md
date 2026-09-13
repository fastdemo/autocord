# Windows manual test checklist

No Windows box was available when `src/platform/win32.js` was written, so
everything tagged `DOCS-UNTESTED` in that file must be confirmed here before
the Windows path is called done. Each item is an exact command plus the
expected output. Nothing below installs, patches, or modifies Discord —
except item 4, which only runs the trigger in `--check` (dry-run) mode.

Prerequisites on the box: Node.js 18+, this repo checked out, Discord
installed (any channel).

## 0. Sanity: platform layer loads, absence handled

```powershell
node -e "const w=require('./src/platform/win32.js'); const i=w.getChannelInfo('stable'); console.log(JSON.stringify({supportDir:i.supportDir, appPath:i.appPath, version:w.getCurrentVersion(i)}))"
```

- Expected on a box WITH Discord: `supportDir` like
  `C:\Users\<you>\AppData\Local\Discord`, `appPath` ending in
  `app-<x.y.z>`, `version` matching `Discord.exe` properties.
- Expected on a box WITHOUT Discord: `appPath: null`, `version: null`
  (must not throw).

## 1. Process detection (`isDiscordRunning`)

With Discord **closed**:

```cmd
tasklist /FI "IMAGENAME eq Discord.exe" /FO CSV /NH
```

- Expected: `INFO: No tasks are running which match the specified criteria.`
- `node -e "console.log(require('./src/platform/win32.js').isDiscordRunning(require('./src/platform/win32.js').getChannelInfo('stable')))"` → `false`.

With Discord **open**: same commands → a CSV row starting
`"Discord.exe",` and `true`. (Use `DiscordPTB.exe` / `DiscordCanary.exe`
for those channels.)

## 2. Graceful quit + force fallback (`quitDiscord`)

With Discord **open**:

```cmd
taskkill /IM Discord.exe
```

- Expected: `SUCCESS: Sent termination signal to the process ...`
- Discord's window should close within seconds WITHOUT the
  `/F` flag. If it lingers past ~20s, the fallback applies:

```cmd
taskkill /F /IM Discord.exe
```

- Expected: `SUCCESS: The process "Discord.exe" with PID ... has been terminated.`

Absent-process case (must not error our flow):

```cmd
taskkill /IM AutocordProbeDoesNotExist123.exe
```

- Expected: `ERROR: The process "AutocordProbeDoesNotExist123.exe" not found.`
  (exit code 128 — our code treats this as "already quit", not failure).

## 3. Relaunch (`relaunchDiscord`)

With Discord **closed**, from `cmd.exe`:

```cmd
"%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe
```

- Expected: Discord window reappears within ~10s, exit code 0.
- Channel variants: `DiscordPTB` dir + `DiscordPTB.exe`, `DiscordCanary`
  dir + `DiscordCanary.exe`, `DiscordDevelopment` dir +
  `DiscordDevelopment.exe`.
- Fallback under test: newest `%LOCALAPPDATA%\Discord\app-*\Discord.exe`
  launched directly. Confirm which of the two the box prefers and report
  back so the code comment can be promoted from DOCS-UNTESTED.

## 4. Toast notification (`sendNotification`)

In an **interactive** session (RDP/console — toasts may be suppressed in
headless sessions, which is itself a finding worth reporting):

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; $xml.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>Autocord</text><text>probe toast — safe to dismiss</text></binding></visual></toast>\"); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Autocord').Show($xml);"
```

- Expected: a visible "Autocord / probe toast" notification, command exits 0.
- If it throws (e.g. no user session), record the exact error — our code
  swallows it by design, but we want to know.

## 5. Scheduled polling task (scheduler design)

```cmd
schtasks /create /sc MINUTE /mo 30 /tn "Autocord Probe" /tr "node C:\path\to\autocord\src\trigger.js --config C:\path\to\config.json" /f
schtasks /query /tn "Autocord Probe"
schtasks /run /tn "Autocord Probe"
```

- Expected: create/query/run all exit 0; a new run appears in the
  configured `logDir\autopatch.log` within a minute.
- Cleanup: `schtasks /delete /tn "Autocord Probe" /f` (exit 0).

## 6. Full trigger dry-run (no changes, safe anywhere)

```cmd
node src\trigger.js --config <config> --channel <installed-channel> --check
```

- Expected: exit 0, log line `version=<x.y.z> patched=<true|false>`,
  no Discord quit, no files changed.

## Explicitly out of scope here

Live patching (`--live`, Vencord or BetterDiscord) on the Windows box
happens only on explicit request — same rule as macOS. Items 0–6 touch
nothing except a probe scheduled task (deleted in step 5).
