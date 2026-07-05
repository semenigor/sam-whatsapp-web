#!/usr/bin/env bash
set -e

APP_ID="sam-whatsapp-web"
APP_NAME="SAM WhatsApp Web"
AUTOSTART_DIR="/etc/xdg/autostart"
AUTOSTART_FILE="${AUTOSTART_DIR}/${APP_ID}.desktop"

mkdir -p "$AUTOSTART_DIR"

cat > "$AUTOSTART_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=WhatsApp Web wrapper with SAM tools
Exec=/usr/bin/${APP_ID}
Icon=${APP_ID}
Terminal=false
Categories=Network;InstantMessaging;
StartupNotify=true
StartupWMClass=SAM WhatsApp Web
X-GNOME-Autostart-enabled=true
DESKTOP

chmod 0644 "$AUTOSTART_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi

exit 0
