#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.18.0 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.18.0
SHA256=131cb58d95cb0ab11dc1a90b9260546bbcc8079a674b2d225665c831df323d5a
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
