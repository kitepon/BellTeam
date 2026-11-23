#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.20.0 (contract 1.36, the local form) in android/packages-local, checked against the sha256 Purika published (t10b, a540). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.20.0
SHA256=39eab9c3f4aa96c0c461be65ab26d7726d24ffe90f112efaccfef6079ae34d16
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
