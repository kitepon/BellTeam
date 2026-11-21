#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.9.1 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.9.1
SHA256=53fcb786227011d7b549c5fd0f4d21e78ecc39296c8368bdce753a07bbc15ed6
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
