#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.17.1 in linux/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.17.1
SHA256=a7874f0bd3b36932f0d6469ab277706ef66c398cf7721ada7c1a88143255ac20
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
