#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.14.0 in linux/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.14.0
SHA256=9078cf04a1de9e4f3c886a7102a64788dfecee7480e6ef952459af219ba27e9a
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
