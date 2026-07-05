#!/usr/bin/env bash
set -e

APP_ID="sam-whatsapp-web"
AUTOSTART_FILE="/etc/xdg/autostart/${APP_ID}.desktop"

rm -f "$AUTOSTART_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

exit 0
