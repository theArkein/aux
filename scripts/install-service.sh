#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(which node)"
ENV_FILE="$REPO_DIR/packages/server/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Copy .env.example and fill in JWT_SECRET."
  exit 1
fi

if [[ "$(uname)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.aux.server.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  mkdir -p "$HOME/.aux"

  # Read env vars from .env file into plist format
  ENV_DICT=""
  while IFS='=' read -r key val; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    key="${key// /}"
    ENV_DICT+="    <key>$key</key>
    <string>$val</string>
"
  done < "$ENV_FILE"

  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aux.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/packages/server/dist/src/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
$ENV_DICT  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.aux/server.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.aux/server.error.log</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR/packages/server</string>
</dict>
</plist>
PLIST
  launchctl load "$PLIST"
  echo "aux server registered as launchd service: com.aux.server"
  echo "Logs: $HOME/.aux/server.log"

elif command -v systemctl &>/dev/null; then
  SERVICE_FILE="$HOME/.config/systemd/user/aux-server.service"
  mkdir -p "$(dirname "$SERVICE_FILE")"
  mkdir -p "$HOME/.aux"
  cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=aux music server
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR/packages/server
ExecStart=$NODE_BIN $REPO_DIR/packages/server/dist/src/server.js
EnvironmentFile=$ENV_FILE
Restart=always
RestartSec=3
StandardOutput=append:$HOME/.aux/server.log
StandardError=append:$HOME/.aux/server.error.log

[Install]
WantedBy=default.target
SERVICE
  systemctl --user daemon-reload
  systemctl --user enable aux-server
  systemctl --user start aux-server
  echo "aux server registered as systemd user service: aux-server"
  echo "Status: systemctl --user status aux-server"

else
  echo "Unsupported platform. Install the server as a service manually."
  exit 1
fi
