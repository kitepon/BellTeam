#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.12.1 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.12.1
SHA256=90a8c8c44fe05f5d06abbfd8da1da63253b9339d2dc206520b4fcabdff8f83ca
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
