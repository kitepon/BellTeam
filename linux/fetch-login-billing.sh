#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.22.2 (contract 1.50, the local form with Apple's web sign-in) in linux/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.22.2
SHA256=92d8e9bd1211ef8d1aecaae66aca803906388f6ed70343987ed420ae12fae55a
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
