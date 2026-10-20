#!/bin/sh
# Point the formula at a published npm version: rewrites url and sha256 in place.
#
#   ./bump.sh            the latest version on npm
#   ./bump.sh 0.2.0      a specific version
#
# Then copy portlight-host.rb into the tap repo (Formula/portlight-host.rb) and push.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
FORMULA="$DIR/portlight-host.rb"
VERSION=${1:-$(npm view portlight-host version)}
URL=$(npm view "portlight-host@$VERSION" dist.tarball)
[ -n "$URL" ] || { echo "error: portlight-host@$VERSION is not on npm" >&2; exit 1; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/portlight-bump.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/pkg.tgz"
SHA=$(shasum -a 256 "$TMP/pkg.tgz" | cut -d' ' -f1)

# npm also records a sha512 of the tarball; check the download against it.
EXPECTED=$(npm view "portlight-host@$VERSION" dist.integrity)
ACTUAL="sha512-$(openssl dgst -sha512 -binary "$TMP/pkg.tgz" | openssl base64 -A)"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "error: download does not match npm's integrity ($EXPECTED)" >&2; exit 1; }

sed -i.bak \
  -e "s|^  url \".*\"|  url \"$URL\"|" \
  -e "s|^  sha256 \".*\"|  sha256 \"$SHA\"|" \
  "$FORMULA"
rm -f "$FORMULA.bak"
ruby -c "$FORMULA" >/dev/null
echo "portlight-host $VERSION"
echo "  url     $URL"
echo "  sha256  $SHA"
