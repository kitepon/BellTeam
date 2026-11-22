#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.18.4 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.18.4
SHA256=e9ed4c6d498a3c9abf6c10b49326380a0e252d1cb63d600d180e2f9bc7dcf351
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
