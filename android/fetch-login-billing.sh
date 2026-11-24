#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.20.4 (contract 1.40; its scanner also reads the local form QR lbq4:) in android/packages-local, checked against the sha256 Purika published (t10b, a540). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.20.4
SHA256=98da24ed448adb6631a7faadea3036ea40b4a188ff40d0f2b7fa14c3798e6ba2
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
