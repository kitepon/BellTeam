#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.20.2 (contract 1.39) in android/packages-local, checked against the sha256 Purika published (t10b, a540). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.20.2
SHA256=ad5ff69f8352e80c76dd67a2fc165e4d72f4add188dfa5057bf85b1e80cb2bba
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
