#!/bin/bash
# Install vencord-autopatch LaunchAgent (macOS).
# Idempotent: safe to re-run after editing config to regenerate WatchPaths.
set -euo pipefail

LABEL="com.vencord-autopatch"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIGGER="$REPO_DIR/src/trigger.js"
CONFIG_DIR="$HOME/.config/vencord-autopatch"
CONFIG_FILE="$CONFIG_DIR/config.json"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found on PATH. Install it first (e.g. brew install node)." >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR" "$HOME/.local/share/vencord-autopatch" "$HOME/Library/Logs/vencord-autopatch"

if [[ ! -f "$CONFIG_FILE" ]]; then
  cp "$REPO_DIR/config.sample.json" "$CONFIG_FILE"
  echo "Wrote default config to $CONFIG_FILE (channels=[stable]; edit me for ptb/canary)."
else
  echo "Keeping existing config at $CONFIG_FILE"
fi

# Warn (don't fail) if the Vencord CLI binary is missing.
CLI_PATH="$("$NODE_BIN" -e '
const {loadConfig} = require(process.argv[1] + "/src/config.js");
try { console.log(loadConfig(process.env.VENCORD_AUTOPATCH_CONFIG || null).installerCli); }
catch (e) { console.log(""); }
' "$REPO_DIR" 2>/dev/null || true)"
if [[ -n "${VENCORD_AUTOPATCH_CONFIG:-}" ]]; then
  echo "Using config override: $VENCORD_AUTOPATCH_CONFIG"
fi
if [[ -z "$CLI_PATH" || ! -x "${CLI_PATH/#\~/$HOME}" ]]; then
  echo "WARNING: Vencord Installer CLI not found/executable at: $CLI_PATH" >&2
  echo "  Build it: brew install go && git clone https://github.com/Vencord/Installer \\" >&2
  echo "    && cd Installer && go build -tags cli -o \"\$HOME/bin/VencordInstallerCli-darwin\"" >&2
  echo "  The trigger will log failures (and notify) until the CLI exists." >&2
fi

# Compute WatchPaths from configured channels (existing paths only).
WATCH_PATHS="$("$NODE_BIN" -e '
const {loadConfig} = require(process.argv[1] + "/src/config.js");
const platform = require(process.argv[1] + "/src/platform/darwin.js");
const cfg = loadConfig(process.env.VENCORD_AUTOPATCH_CONFIG || null);
const out = [];
for (const ch of cfg.channels) {
  try { out.push(...platform.getWatchPaths(platform.getChannelInfo(ch))); } catch (e) {}
}
console.log(JSON.stringify([...new Set(out)]));
' "$REPO_DIR")"

if [[ "$WATCH_PATHS" == "[]" ]]; then
  echo "WARNING: no WatchPaths resolved (Discord .app + support dirs missing for configured channels)." >&2
  echo "  Install Discord or fix channels in $CONFIG_FILE, then re-run this script." >&2
fi

echo "WatchPaths: $WATCH_PATHS"

# Build plist with python3 (safer XML than sed).
CONFIG_ESCAPED="${VENCORD_AUTOPATCH_CONFIG:-$CONFIG_FILE}"
python3 - "$PLIST" "$NODE_BIN" "$TRIGGER" "$CONFIG_ESCAPED" "$WATCH_PATHS" <<'EOF'
import json, plistlib, sys
plist_path, node_bin, trigger, config, watch_json = sys.argv[1:6]
watch = json.loads(watch_json)
home = __import__("os").path.expanduser("~")
d = {
    "Label": "com.vencord-autopatch",
    "ProgramArguments": [node_bin, trigger, "--config", config],
    "WatchPaths": watch,
    "ThrottleInterval": 0,
    "RunAtLoad": True,
    "ProcessType": "Background",
    "StandardOutPath": home + "/Library/Logs/vencord-autopatch/launchd.stdout.log",
    "StandardErrorPath": home + "/Library/Logs/vencord-autopatch/launchd.stderr.log",
}
with open(plist_path, "wb") as f:
    plistlib.dump(d, f)
print(f"Wrote {plist_path}")
EOF

plutil -lint "$PLIST"

# (Re)load.
if launchctl list "$LABEL" >/dev/null 2>&1; then
  launchctl unload "$PLIST" 2>/dev/null || true
fi
launchctl load "$PLIST"
echo "Loaded $LABEL"
launchctl list "$LABEL" | head -n 5 || true

echo ""
echo "Verify:"
echo "  1. Status:   autocord status"
echo "  2. Dry run:  autocord patch --channel <name>   (add --force for a real run)"
echo "  3. Logs:     autocord logs"
echo "  4. Bump-test: touch \"\$HOME/Library/Application Support/discord\" (or your channel dir),"
echo "     then check 'autocord logs' for a launchd-triggered run within seconds."
