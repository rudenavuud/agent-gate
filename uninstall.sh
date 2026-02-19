#!/usr/bin/env bash
set -euo pipefail

#
# agent-gate uninstaller
#
# Removes the agent-gate daemon, CLI, services, and optionally the
# system user and config.
#
# Usage: sudo bash uninstall.sh
#

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[agent-gate]${NC} $*"; }
ok()    { echo -e "${GREEN}[agent-gate]${NC} $*"; }
warn()  { echo -e "${YELLOW}[agent-gate]${NC} $*"; }

if [[ $EUID -ne 0 ]]; then
  echo -e "${RED}[agent-gate]${NC} This script must be run as root (use sudo)" >&2
  exit 1
fi

OS="$(uname -s)"

# ─── Stop services ───────────────────────────────────────────────────

info "Stopping services..."

if [[ "$OS" == "Linux" ]] && command -v systemctl &>/dev/null; then
  systemctl stop agent-gate 2>/dev/null || true
  systemctl disable agent-gate 2>/dev/null || true
  rm -f /etc/systemd/system/agent-gate.service
  systemctl daemon-reload 2>/dev/null || true
  ok "systemd service removed"
elif [[ "$OS" == "Darwin" ]]; then
  PLIST="/Library/LaunchDaemons/com.agent-gate.daemon.plist"
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  ok "launchd plist removed"
fi

# ─── Remove files ────────────────────────────────────────────────────

info "Removing files..."

rm -rf /opt/agent-gate
rm -f /usr/local/bin/agent-gate
rm -rf /run/agent-gate

ok "Files removed"

# ─── Config ──────────────────────────────────────────────────────────

if [[ -d /etc/agent-gate ]]; then
  read -rp "Remove config at /etc/agent-gate? [y/N] " answer
  if [[ "${answer,,}" == "y" ]]; then
    rm -rf /etc/agent-gate
    ok "Config removed"
  else
    warn "Config preserved at /etc/agent-gate/"
  fi
fi

# ─── User ─────────────────────────────────────────────────────────────

if id agent-gate &>/dev/null; then
  read -rp "Remove system user 'agent-gate'? [y/N] " answer
  if [[ "${answer,,}" == "y" ]]; then
    if [[ "$OS" == "Linux" ]]; then
      userdel agent-gate 2>/dev/null || true
    elif [[ "$OS" == "Darwin" ]]; then
      dscl . -delete /Users/agent-gate 2>/dev/null || true
    fi
    ok "User removed"
  else
    warn "User 'agent-gate' preserved"
  fi
fi

echo ""
ok "agent-gate uninstalled"
