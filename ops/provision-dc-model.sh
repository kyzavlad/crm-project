#!/usr/bin/env bash
set -Eeuo pipefail

SITE="${SITE:-/var/www/fastuser/data/www/crmrc.app}"
RUNTIME_SOURCE="${RUNTIME_SOURCE:-$SITE/connector-runtime}"
SLUG="${1:-}"
CONFIG_SOURCE="${2:-}"

if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Usage: $0 <slug> <prepared-config.js>" >&2
  exit 2
fi
if [[ -z "$CONFIG_SOURCE" || ! -f "$CONFIG_SOURCE" ]]; then
  echo "Prepared config file is required" >&2
  exit 2
fi

TARGET="$SITE/connector-$SLUG"
SERVICE="dc-connector-$SLUG.service"
UNIT="/etc/systemd/system/$SERVICE"

for f in dc-connector.js package.json package-lock.json; do
  [[ -f "$RUNTIME_SOURCE/$f" ]] || { echo "Missing runtime source: $f" >&2; exit 3; }
done
node -c "$RUNTIME_SOURCE/dc-connector.js"
mkdir -p "$TARGET"
chmod 700 "$TARGET"
for f in dc-connector.js package.json package-lock.json .gitignore README.md config.example.js; do
  [[ -f "$RUNTIME_SOURCE/$f" ]] && install -m 600 "$RUNTIME_SOURCE/$f" "$TARGET/$f"
done
install -m 600 "$CONFIG_SOURCE" "$TARGET/config.js"

if [[ ! -e "$TARGET/node_modules" ]]; then
  if [[ -d "$RUNTIME_SOURCE/node_modules" ]]; then
    ln -s "$RUNTIME_SOURCE/node_modules" "$TARGET/node_modules"
  else
    (cd "$TARGET" && npm ci --omit=dev)
  fi
fi
node -c "$TARGET/dc-connector.js"

cat > "$UNIT" <<UNIT
[Unit]
Description=Dating.com background connector - $SLUG
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$TARGET
ExecStart=/usr/bin/node $TARGET/dc-connector.js
Environment=NODE_ENV=production
Restart=always
RestartSec=15
RuntimeMaxSec=6h
MemoryMax=2G
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 12
systemctl is-active --quiet "$SERVICE"
echo "SERVICE=$SERVICE STATUS=active TARGET=$TARGET"
