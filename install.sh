#!/bin/sh
# Portlight: build the extension and connect the native helper to it (macOS / Linux).
#
#   ./install.sh                   build + install the helper for this extension
#   ./install.sh <extension-id>    also allow another ID (e.g. a store install)
#   ./install.sh --all-browsers    write manifests even for browsers that don't look installed
#   ./install.sh --uninstall       remove the helper
#
# Needs Node.js 18+ and npm. Safe to re-run (e.g. after git pull or switching Node versions).
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

for arg in "$@"; do
  case "$arg" in
    --uninstall) exec "$ROOT/host/uninstall.sh" ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "error: Node.js 18+ with npm is required (https://nodejs.org)" >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "error: Node.js 18+ is required, found $(node --version)" >&2
  exit 1
fi

LOG=$(mktemp "${TMPDIR:-/tmp}/portlight-install.XXXXXX")
trap 'rm -f "$LOG"' EXIT
run() {
  if ! "$@" >"$LOG" 2>&1; then
    cat "$LOG" >&2
    echo "error: '$*' failed" >&2
    exit 1
  fi
}

echo "Building the extension"
cd "$ROOT/extension"
if [ ! -d node_modules ]; then
  echo "  installing build tools (npm ci, first run only)"
  run npm ci --no-audit --no-fund
fi
run npm run build
echo "  built      $ROOT/extension/dist"

ID=$(node scripts/extension-id.mjs)
echo "  ID         $ID (pinned by the manifest key)"
echo

"$ROOT/host/install.sh" "$ID" "$@"

cat <<EOF

Last step, once per browser:
  1. Open chrome://extensions and turn on Developer mode (top right).
  2. Click "Load unpacked" and choose:
       $ROOT/extension/dist

After a later ./install.sh, click the reload arrow on the Portlight card.
EOF
