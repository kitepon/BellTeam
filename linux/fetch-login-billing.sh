#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.20.3 (contract 1.40, the local form with Google's desktop client secret) in linux/packages-local, checked against the sha256 Purika published (t10b, a540). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.20.3
SHA256=d62de5e3a9233157152796a8083ba11cad5801187588101daccdaa70133bf5d3
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
