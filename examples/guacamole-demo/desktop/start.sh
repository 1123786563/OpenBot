#!/bin/sh
set -eu

Xvfb :0 -screen 0 1280x800x24 -nolisten tcp &
sleep 1
openbox &
xterm -geometry 110x30+80+80 -title "OpenBot desktop demo" \
  -e sh -c 'printf "OpenBot / Guacamole demo\n\nThis is a native Linux window.\nType here to confirm that keyboard input reaches the desktop.\n\n"; exec sh' &
exec x11vnc -display :0 -forever -shared -rfbport 5900 -nopw
