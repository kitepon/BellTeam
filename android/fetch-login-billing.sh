#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.24.0 (contract 1.58; its scanner also reads the local form QR lbq4:) in android/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.24.0
SHA256=10f281a053a4fc2d69a4b36cfda6b1dc2f3c39275196a08d5cf5038bd80a194d
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
