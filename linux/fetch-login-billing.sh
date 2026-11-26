#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.24.1 (contract 1.59, a browser is admitted only with its own consent) in linux/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.24.1
SHA256=4e16afbff19f03f82fdfdf8ceb2e9f2d4d3cc67b88135ef1af9b90bd22ec2e3f
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
