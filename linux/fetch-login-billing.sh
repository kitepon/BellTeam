#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.22.1 (contract 1.50, the local form with Apple's web sign-in) in linux/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.22.1
SHA256=edbb0aace062104165a6f5837a6a4ca4ba216ca44ff6e111a578278f93178e87
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
