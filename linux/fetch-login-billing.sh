#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.19.3 in linux/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.19.3
SHA256=4ab076d903354190b4e40cc6abc8d6119fe0f6ea3968522b68a439a9d025e277
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
