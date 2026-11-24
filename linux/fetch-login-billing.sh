#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.21.1 (contract 1.48, the local form with Apple's web sign-in) in linux/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.21.1
SHA256=51426ae59549cb85a0b7980b525caa5bed452058e685243da79bd828513ec12c
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
