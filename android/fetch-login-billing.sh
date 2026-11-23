#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.20.3 (contract 1.40) in android/packages-local, checked against the sha256 Purika published (t10b, a540). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.20.3
SHA256=68eb767194a6a8d20bf93e446620955c40ef267ded8c5f0d584a80aad3c61f63
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
