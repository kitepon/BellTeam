#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.17.0 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.17.0
SHA256=9e9a8c3730cf366d1af6e22f281db7c8a6133a2e7505c86a3543a02e0ad551f3
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
