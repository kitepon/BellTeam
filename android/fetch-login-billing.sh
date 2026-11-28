#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.26.0 (contracts 1.60 and 1.61; its scanner also reads the local form QR lbq4:) in android/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.26.0
SHA256=a367c6d1039627697c9e1843d6ba39d04467c0a3713fda3d52b9a6426e83ed0e
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
