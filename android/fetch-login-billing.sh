#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.23.1 (contract 1.56; its scanner also reads the local form QR lbq4:) in android/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.23.1
SHA256=b810efb0e577bb0b063d39b7cf0cb5b5a9de9afab22ceae124cc7ce52a89159c
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
