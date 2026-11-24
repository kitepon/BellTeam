#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.22.1 (contract 1.50; its scanner also reads the local form QR lbq4:) in android/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.22.1
SHA256=960edd67181db0528f99a23abad7451d42bd477fef548524341e36b063584f04
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
