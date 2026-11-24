#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.22.4 (contract 1.50, the local form with Apple's web sign-in) in linux/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.22.4
SHA256=59e07e7ddec1df06b5b4ad5af044cfb41dabd25e05ca9c577f3c5fc70bf7be21
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
