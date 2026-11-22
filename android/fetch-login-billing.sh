#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.18.1 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.18.1
SHA256=f464610613bddc64d39db7ff0e9d1201a0237ba53e7e90089367a3bc40aa5a5c
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
