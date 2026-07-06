#!/usr/bin/env bash
set -e

APP_ID="sam-whatsapp-web"

BIN_LINK="/usr/bin/${APP_ID}"
AUTOSTART_FILE="/etc/xdg/autostart/${APP_ID}.desktop"

if [ -L "$BIN_LINK" ]; then
  rm -f "$BIN_LINK"
fi

rm -f "$AUTOSTART_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

exit 0
