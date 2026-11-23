#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.20.2 (contract 1.39, the local form with Google's desktop client secret) in linux/packages-local, checked against the sha256 Purika published (t10b, a540). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.20.2
SHA256=de8e3d7c93bb21ec14fcc3153e0815807c602cb5d7c7eeef656a6f3031f48934
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
