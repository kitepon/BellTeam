#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.11.0 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.11.0
SHA256=b2cc991c2ca34a2eb4727d2722246b4da7f69f4de41b33cbc91aff6137f87722
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
