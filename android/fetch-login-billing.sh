#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.25.1 (contracts 1.60 and 1.61; its scanner also reads the local form QR lbq4:) in android/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.25.1
SHA256=e7ecc63989080c41ebd25d0b28c50715d4f351a14266bd52b466a130a2a2acc9
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
