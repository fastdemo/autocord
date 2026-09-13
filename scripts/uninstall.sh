#!/bin/bash
# Uninstall vencord-autopatch LaunchAgent (macOS).
# Default keeps config/state/logs; pass --purge to remove those too.
set -euo pipefail

LABEL="com.vencord-autopatch"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PURGE=0
for a in "$@"; do
  [[ "$a" == "--purge" ]] && PURGE=1
done

if launchctl list "$LABEL" >/dev/null 2>&1; then
  launchctl unload "$PLIST" 2>/dev/null || launchctl remove "$LABEL" 2>/dev/null || true
  echo "Unloaded $LABEL"
else
  echo "$LABEL not loaded (nothing to unload)"
fi

if [[ -f "$PLIST" ]]; then
  rm -f "$PLIST"
  echo "Removed $PLIST"
fi

if [[ "$PURGE" == "1" ]]; then
  rm -rf "$HOME/.config/vencord-autopatch" \
         "$HOME/.local/share/vencord-autopatch" \
         "$HOME/Library/Application Support/vencord-autopatch" \
         "$HOME/Library/Logs/vencord-autopatch"
  echo "Purged config, state, and logs"
else
  echo "Kept config/state/logs (re-run with --purge to remove them)"
fi
