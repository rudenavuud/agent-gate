#!/usr/bin/env bash
set -euo pipefail

#
# agent-gate installer
#
# Creates the agent-gate system user, installs the daemon and CLI,
# sets up systemd services, and configures file permissions.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/rudenavuud/agent-gate/main/install.sh | bash
#   # or from a local clone:
#   sudo bash install.sh
#
# What this script does:
#   1. Creates system user `agent-gate` (no shell, no login)
#   2. Copies source to /opt/agent-gate/
#   3. Installs config template to /etc/agent-gate/
#   4. Creates runtime directory /run/agent-gate/
#   5. Installs systemd service (Linux) or launchd plist (macOS)
#   6. Links CLI to /usr/local/bin/agent-gate
#
# What this script does NOT do:
#   - Install Node.js (you need >= 18)
#   - Configure your secret provider or approval channels
#   - Set up the service account token
#
# After install, edit /etc/agent-gate/config.json and start:
#   sudo systemctl start agent-gate
#

INSTALL_DIR="/opt/agent-gate"
CONFIG_DIR="/etc/agent-gate"
RUN_DIR="/run/agent-gate"
SERVICE_USER="agent-gate"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Colors ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[agent-gate]${NC} $*"; }
ok()    { echo -e "${GREEN}[agent-gate]${NC} $*"; }
warn()  { echo -e "${YELLOW}[agent-gate]${NC} $*"; }
error() { echo -e "${RED}[agent-gate]${NC} $*" >&2; }

# ─── Preflight ────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root (use sudo)"
  exit 1
fi

# Check Node.js
if ! command -v node &>/dev/null; then
  error "Node.js not found. Install Node.js >= 18 first:"
  error "  https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [[ "$NODE_VERSION" -lt 18 ]]; then
  error "Node.js >= 18 required (found v${NODE_VERSION})"
  exit 1
fi

info "Node.js v$(node --version | tr -d v) ✓"

# ─── Detect OS ────────────────────────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
  Linux)  info "Detected Linux" ;;
  Darwin) info "Detected macOS" ;;
  *)      error "Unsupported OS: $OS"; exit 1 ;;
esac

# ─── Create system user ──────────────────────────────────────────────

if id "$SERVICE_USER" &>/dev/null; then
  info "User '$SERVICE_USER' already exists"
else
  info "Creating system user '$SERVICE_USER'..."
  if [[ "$OS" == "Linux" ]]; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  elif [[ "$OS" == "Darwin" ]]; then
    # macOS: create a hidden system user
    LAST_ID=$(dscl . -list /Users UniqueID | awk '{print $2}' | sort -n | tail -1)
    NEXT_ID=$((LAST_ID + 1))
    dscl . -create /Users/"$SERVICE_USER"
    dscl . -create /Users/"$SERVICE_USER" UserShell /usr/bin/false
    dscl . -create /Users/"$SERVICE_USER" UniqueID "$NEXT_ID"
    dscl . -create /Users/"$SERVICE_USER" PrimaryGroupID 20
    dscl . -create /Users/"$SERVICE_USER" IsHidden 1
  fi
  ok "Created user '$SERVICE_USER'"
fi

# ─── Install source ──────────────────────────────────────────────────

info "Installing to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

# If running from the repo, copy source files
if [[ -f "$SCRIPT_DIR/src/daemon.js" ]]; then
  cp -r "$SCRIPT_DIR/src" "$INSTALL_DIR/"
  cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
  [[ -f "$SCRIPT_DIR/config.example.json" ]] && cp "$SCRIPT_DIR/config.example.json" "$INSTALL_DIR/"
else
  # Download from GitHub
  info "Downloading from GitHub..."
  TMPDIR=$(mktemp -d)
  if command -v curl &>/dev/null; then
    curl -fsSL "https://github.com/rudenavuud/agent-gate/archive/refs/heads/main.tar.gz" | \
      tar xz -C "$TMPDIR" --strip-components=1
  elif command -v wget &>/dev/null; then
    wget -qO- "https://github.com/rudenavuud/agent-gate/archive/refs/heads/main.tar.gz" | \
      tar xz -C "$TMPDIR" --strip-components=1
  else
    error "Need curl or wget to download"; exit 1
  fi
  cp -r "$TMPDIR/src" "$INSTALL_DIR/"
  cp "$TMPDIR/package.json" "$INSTALL_DIR/"
  [[ -f "$TMPDIR/config.example.json" ]] && cp "$TMPDIR/config.example.json" "$INSTALL_DIR/"
  rm -rf "$TMPDIR"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
ok "Source installed to $INSTALL_DIR"

# ─── Install config ──────────────────────────────────────────────────

mkdir -p "$CONFIG_DIR"

if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
  if [[ -f "$INSTALL_DIR/config.example.json" ]]; then
    cp "$INSTALL_DIR/config.example.json" "$CONFIG_DIR/config.json"
    warn "Config template installed to $CONFIG_DIR/config.json"
    warn "  ⚠  Edit this file before starting the daemon!"
  fi
else
  info "Config already exists at $CONFIG_DIR/config.json (not overwritten)"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"
chmod 600 "$CONFIG_DIR/config.json" 2>/dev/null || true

# ─── Create runtime directory ────────────────────────────────────────

mkdir -p "$RUN_DIR/pending"
chown -R "$SERVICE_USER:$SERVICE_USER" "$RUN_DIR"
chmod 755 "$RUN_DIR"
chmod 777 "$RUN_DIR/pending"  # Agent user needs write access
ok "Runtime directory: $RUN_DIR"

# ─── Link CLI ────────────────────────────────────────────────────────

chmod +x "$INSTALL_DIR/src/cli.js"
ln -sf "$INSTALL_DIR/src/cli.js" /usr/local/bin/agent-gate
ok "CLI linked: /usr/local/bin/agent-gate"

# ─── Install service ─────────────────────────────────────────────────

if [[ "$OS" == "Linux" ]]; then
  # systemd
  if command -v systemctl &>/dev/null; then
    cp "$SCRIPT_DIR/systemd/agent-gate.service" /etc/systemd/system/ 2>/dev/null || \
    cat > /etc/systemd/system/agent-gate.service <<'UNIT'
[Unit]
Description=agent-gate — Human-in-the-loop secret approval for AI agents
After=network.target

[Service]
Type=simple
User=agent-gate
Group=agent-gate
ExecStartPre=/bin/mkdir -p /run/agent-gate
ExecStartPre=/bin/chown agent-gate:agent-gate /run/agent-gate
ExecStart=/usr/bin/node /opt/agent-gate/src/daemon.js
Environment=AGENT_GATE_CONFIG=/etc/agent-gate/config.json
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/run/agent-gate
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT

    systemctl daemon-reload
    ok "systemd service installed: agent-gate.service"
    info "  Start with: sudo systemctl enable --now agent-gate"
  else
    warn "systemd not found — you'll need to start the daemon manually"
  fi

elif [[ "$OS" == "Darwin" ]]; then
  # launchd
  PLIST="/Library/LaunchDaemons/com.agent-gate.daemon.plist"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agent-gate.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/agent-gate/src/daemon.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_GATE_CONFIG</key>
    <string>/etc/agent-gate/config.json</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>UserName</key>
  <string>agent-gate</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/var/log/agent-gate.log</string>
  <key>StandardErrorPath</key>
  <string>/var/log/agent-gate.log</string>
</dict>
</plist>
PLIST

  ok "launchd plist installed: $PLIST"
  info "  Start with: sudo launchctl load $PLIST"
fi

# ─── Done ─────────────────────────────────────────────────────────────

echo ""
ok "═══════════════════════════════════════════════════"
ok "  agent-gate installed successfully!"
ok "═══════════════════════════════════════════════════"
echo ""
info "Next steps:"
echo "  1. Edit config:    sudo nano $CONFIG_DIR/config.json"
echo "  2. Set up your secret provider (e.g., 1Password service account)"
echo "  3. Configure approval channel (e.g., Telegram bot token + chat ID)"

if [[ "$OS" == "Linux" ]] && command -v systemctl &>/dev/null; then
  echo "  4. Start daemon:   sudo systemctl enable --now agent-gate"
elif [[ "$OS" == "Darwin" ]]; then
  echo "  4. Start daemon:   sudo launchctl load /Library/LaunchDaemons/com.agent-gate.daemon.plist"
fi

echo "  5. Test:           agent-gate ping"
echo ""
info "Docs: https://github.com/rudenavuud/agent-gate"
