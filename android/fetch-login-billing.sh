#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.24.1 (contract 1.59; its scanner also reads the local form QR lbq4:) in android/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.24.1
SHA256=5f5cdf6501141f5bc4ad685ab05a3354236eb93732ffef5acc66a5b8a45a3a61
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
