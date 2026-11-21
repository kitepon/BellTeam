#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.17.1 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.17.1
SHA256=07f4768dc0e4938d271507cf26f0b5c8b27ee837a6deaeb1eb681bc63fbba39d
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
