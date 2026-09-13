#!/bin/bash
# Autocord one-line installer for end users (no dev setup assumed).
#
#   curl -fsSL https://raw.githubusercontent.com/fastdemo/autocord/main/install.sh | bash
#
# What it does:
#   1. Checks for Node.js >= 22 (auto-installs via Homebrew on macOS when
#      available, otherwise points at https://nodejs.org with copy-paste steps).
#   2. Installs the CLI (npm global; falls back to git clone + local install
#      if the registry step fails, e.g. offline or unpublished).
#   3. Walks straight into `autocord config` interactively.
#   4. Prints next steps (`autocord install`, `autocord status`).
#
# The Go toolchain / Vencord-installer build is NOT handled here on purpose:
# `autocord install` already performs that transparently
# (auto-detect → one-time `brew install go` + source build), so the end user
# never learns Go is involved.
#
# Env overrides (scripting/tests):
#   AUTOCORD_NPM_PACKAGE   package spec for step 2 (default: autocord-cli)
#   VENCORD_AUTOPATCH_CONFIG  passed through to `autocord config`
set -euo pipefail

PKG="${AUTOCORD_NPM_PACKAGE:-autocord-cli}"
MIN_NODE_MAJOR=22

have_cmd() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0
}

echo "Autocord setup"
echo ""

# --- 1. Node.js -------------------------------------------------------------
if have_cmd node && [ "$(node_major)" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
  echo "  Node $(node --version) found."
else
  echo "  Node.js $MIN_NODE_MAJOR+ is required but was not found."
  if [ "$(uname -s)" = "Darwin" ] && have_cmd brew; then
    echo "  Installing Node.js via Homebrew (one-time)..."
    brew install node
  else
    echo ""
    echo "  Install it first, then re-run this script:"
    echo "    macOS:   brew install node   (from https://brew.sh)"
    echo "    Windows: winget install OpenJS.NodeJS.LTS"
    echo "    Linux:   https://nodejs.org/en/download (LTS)"
    exit 1
  fi
fi

# --- 2. CLI -----------------------------------------------------------------
if have_cmd autocord; then
  echo "  'autocord' already on PATH ($(command -v autocord)) — refreshing."
fi
if ! npm install -g --force "$PKG" 2>/dev/null; then
  echo "  npm install failed for '$PKG' — falling back to source install."
  have_cmd git || { echo "  git is required for the fallback. Install git: https://git-scm.com/downloads"; exit 1; }
  SRC_DIR="${AUTOCORD_SRC_DIR:-$HOME/.local/share/autocord-repo}"
  if [ -d "$SRC_DIR/.git" ]; then
    git -C "$SRC_DIR" pull --ff-only 2>/dev/null || true
  else
    rm -rf "$SRC_DIR"
    git clone --depth 1 https://github.com/fastdemo/autocord "$SRC_DIR"
  fi
  npm install -g "$SRC_DIR"
fi
if ! have_cmd autocord; then
  echo ""
  echo "  Installed, but 'autocord' is not on your PATH."
  if [ "$(uname -s)" = "Windows_NT" ] || [ -n "${WINDIR:-}" ]; then
    echo "  npm global dir: $(npm config get prefix 2>/dev/null)"
  else
    echo "  npm global bin: $(npm config get prefix 2>/dev/null)/bin"
  fi
  echo "  Add that directory to PATH, open a new terminal, then run: autocord config"
  exit 1
fi
echo "  autocord installed: $(command -v autocord)"

# --- 3. Straight into config ------------------------------------------------
# NOTE: under `curl | bash`, stdin is the (exhausted) pipe, not the terminal,
# so hand the interactive step an explicit terminal when stdin isn't one.
# (/dev/tty exists as a node even with no controlling terminal, so probe it
# with a no-op redirect instead of trusting -r/-w.)
echo ""
echo "  Next: a few quick questions to configure Autocord."
if [ -t 0 ]; then
  exec autocord config
elif true 2>/dev/null </dev/tty >/dev/tty; then
  exec autocord config </dev/tty >/dev/tty 2>&1
else
  echo "  No interactive terminal available — run this yourself: autocord config"
  echo ""
  echo "  Then: autocord install   (sets up background auto-patching)"
  echo "  Check: autocord status  ·  autocord logs"
fi
