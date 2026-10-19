#!/bin/sh
# Remove the Portlight native messaging host and its browser manifests (macOS / Linux).
set -eu

HOST_NAME="com.portlight.host"
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SRC_DIR/scripts/browsers.sh"

remove_one() {
  f="$2/NativeMessagingHosts/$HOST_NAME.json"
  if [ -f "$f" ]; then
    rm -f "$f"
    echo "  removed    $f"
  fi
}

echo "Uninstalling Portlight host ($HOST_NAME)"
for_each_browser remove_one
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "  removed    $INSTALL_DIR"
  rmdir "$(dirname "$INSTALL_DIR")" 2>/dev/null || true
fi
echo "Done."
