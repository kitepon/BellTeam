#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.14.0 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.14.0
SHA256=a83b161ee43f7e9cfff93a2c5a0b54b42a0f73329133f4506184c4950c52ec0b
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
