#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.25.2 (contracts 1.60 and 1.61; its scanner also reads the local form QR lbq4:) in android/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.25.2
SHA256=f4476d7f47243001842c38f6a137a399ab4c85b6242d8534223673c71a06e3f8
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
