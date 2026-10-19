#!/bin/sh
# Install the Portlight native messaging host for Chromium-based browsers (macOS / Linux).
#
#   ./install.sh <extension-id> [<extension-id> ...] [--all-browsers]
#
# Copies the host into a per-user directory, writes a launcher that pins the current
# `node` binary (browsers start hosts with a minimal PATH), and writes the host manifest
# for every installed browser. Safe to re-run; prints every file it writes.
set -eu

HOST_NAME="com.portlight.host"
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

usage() {
  echo "usage: $0 <extension-id> [<extension-id> ...] [--all-browsers]" >&2
  echo "  --all-browsers  write manifests even for browsers that don't look installed" >&2
  exit 2
}

IDS=""
ALL=0
for arg in "$@"; do
  case "$arg" in
    --all-browsers) ALL=1 ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $arg" >&2; usage ;;
    *)
      if ! printf '%s' "$arg" | grep -Eq '^[a-p]{32}$'; then
        echo "error: '$arg' is not a Chrome extension ID (32 letters a-p, see chrome://extensions)" >&2
        exit 2
      fi
      IDS="$IDS $arg" ;;
  esac
done
[ -n "$IDS" ] || usage

NODE_BIN=${NODE:-$(command -v node || true)}
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "error: node not found on PATH (set NODE=/path/to/node)" >&2
  exit 1
fi
NODE_BIN=$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")
if ! "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "error: node >= 18 required, found $("$NODE_BIN" --version)" >&2
  exit 1
fi

. "$SRC_DIR/scripts/browsers.sh"

# Write $2 to file $1 only if it differs; report what happened.
put() {
  if [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; then
    echo "  unchanged  $1"
  else
    mkdir -p "$(dirname "$1")"
    printf '%s\n' "$2" > "$1"
    echo "  wrote      $1"
  fi
}

echo "Installing Portlight host ($HOST_NAME)"
echo "  node       $NODE_BIN ($("$NODE_BIN" --version))"

# 1. Host files.
for f in package.json src/*.js; do
  put "$INSTALL_DIR/$f" "$(cat "$SRC_DIR/$f")"
done
# Drop files left over from older versions.
for f in "$INSTALL_DIR"/src/*.js; do
  [ -f "$SRC_DIR/src/$(basename "$f")" ] || { rm -f "$f"; echo "  removed    $f"; }
done

# 2. Launcher with an absolute node path.
LAUNCHER="$INSTALL_DIR/portlight-host"
put "$LAUNCHER" "#!/bin/sh
exec \"$NODE_BIN\" \"$INSTALL_DIR/src/main.js\" \"\$@\""
chmod 755 "$LAUNCHER"

# 3. Manifest (built by node so paths are JSON-escaped correctly).
MANIFEST=$("$NODE_BIN" -e '
const [name, path, ...ids] = process.argv.slice(1);
console.log(JSON.stringify({
  name,
  description: "Portlight: reports which localhost ports are in use",
  path,
  type: "stdio",
  allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
}, null, 2));' "$HOST_NAME" "$LAUNCHER" $IDS)

install_one() {
  label=$1 profile=$2
  if [ "$ALL" = 1 ] || [ -d "$profile" ]; then
    put "$profile/NativeMessagingHosts/$HOST_NAME.json" "$MANIFEST"
    WROTE=$((WROTE + 1))
  else
    echo "  skipped    $label (not installed)"
  fi
}

WROTE=0
for_each_browser install_one

echo
echo "Manifest:"
printf '%s\n' "$MANIFEST" | sed 's/^/  /'
echo
if [ "$WROTE" = 0 ]; then
  echo "warning: no supported browser found; re-run with --all-browsers to write manifests anyway" >&2
  exit 1
fi
echo "Done: $WROTE browser(s). Reload the extension to connect."
