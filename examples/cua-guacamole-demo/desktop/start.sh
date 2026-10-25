#!/bin/sh
set -eu

mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
eval "$(dbus-launch --sh-syntax)"

Xvfb :0 -screen 0 1280x800x24 -nolisten tcp &
sleep 2
openbox &
xterm -geometry 110x30+80+80 -title "OpenBot CUA + Guacamole" \
  -e sh -c 'printf "OpenBot CUA + Guacamole demo\n\nWatch this window from Guacamole while CUA Driver acts.\n\n"; exec sh' &
cua-driver serve > /tmp/cua-driver.log 2>&1 &
exec x11vnc -display :0 -forever -shared -rfbport 5900 -nopw
