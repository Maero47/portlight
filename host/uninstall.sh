#!/bin/sh
# Remove the Portlight native messaging host and its browser manifests (macOS / Linux).
# Thin wrapper over `portlight-host uninstall`.
set -eu
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN=${NODE:-$(command -v node || true)}
if [ -z "$NODE_BIN" ]; then
  echo "error: Node.js is required to run the uninstaller (https://nodejs.org)" >&2
  exit 1
fi
exec "$NODE_BIN" "$SRC_DIR/src/main.js" uninstall
