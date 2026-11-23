#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.20.1 (contract 1.37, the local form with Google's desktop client secret) in linux/packages-local, checked against the sha256 Purika published (t10b, a540). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.20.1
SHA256=edb12fb5a5809869d78d0dba3cc2d892d6cd067a640d42a77e5b13b3dfa53ffd
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
