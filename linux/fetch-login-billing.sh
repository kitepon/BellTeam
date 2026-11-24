#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.20.4 (contract 1.40, the local form with Google's desktop client secret) in linux/packages-local, checked against the sha256 Purika published (t10b, a540). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.20.4
SHA256=46bc3fb8c0b8ccf3827702041fdd7e4eded6a6a41072ef4a64e8cdd16d31254f
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
