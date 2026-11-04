#!/bin/sh
# Terminals inside Electron-based IDEs can leak this, which would make electron run as plain node.
unset ELECTRON_RUN_AS_NODE
exec /usr/bin/@ELECTRON@ /usr/lib/pdf-editor "$@"
