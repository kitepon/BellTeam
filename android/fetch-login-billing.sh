#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.18.9 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.18.9
SHA256=c19552ad4394f1e4e38d1a4781f2a9646011c0df0bac3c1dd6e88b83dd2a897e
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
