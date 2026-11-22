#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.18.9 in linux/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.18.9
SHA256=e567b61c430b8cd063378faa3a208699564e94825be5f7b0b8bda75b25f0646f
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
