#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.24.0 (contract 1.58, the local form with Apple's web sign-in) in linux/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.24.0
SHA256=c9e7de26adb616829ebbd4b10df13e5bebd6588458452bf6faa14eaf97037a22
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
