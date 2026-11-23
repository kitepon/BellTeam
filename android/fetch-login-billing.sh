#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.20.1 (contract 1.37, the local form) in android/packages-local, checked against the sha256 Purika published (t10b, a540). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.20.1
SHA256=a06ea0f2ddc1186c0846759adf2fc60c9439c8e11e40364674f0c72b2ac918a9
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
