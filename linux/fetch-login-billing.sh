#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.20.0 (contract 1.36, the local form) in linux/packages-local, checked against the sha256 Purika published (t10b, a540). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.20.0
SHA256=c9244b8059e7adfa4b2d3a702b7c19e48974e54a7bc3ef3cd1a5880e72853e74
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
