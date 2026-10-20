#!/bin/sh
# Install the Portlight native messaging host (macOS / Linux). Thin wrapper over
# `portlight-host install`; see src/installer.js.
#
#   ./install.sh [<extension-id> ...] [--extension-id <id>] [--all-browsers]
#
# Set NODE=/path/to/node to pin a different node in the launcher.
set -eu
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN=${NODE:-$(command -v node || true)}
if [ -z "$NODE_BIN" ]; then
  echo "error: Node.js 18+ is required (https://nodejs.org)" >&2
  exit 1
fi
exec "$NODE_BIN" "$SRC_DIR/src/main.js" install "$@"
