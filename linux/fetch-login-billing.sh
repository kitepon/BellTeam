#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.26.0 (contracts 1.60 and 1.61: the join code beside the QR, the return link, the local-network words) in linux/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.26.0
SHA256=02c0ed310c12d9491e2f9d324e52a3b02c97ecb03ed0bbaa97dfd1a301049c52
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
