#!/bin/sh
# Puts Kitepon.LoginBilling.Desktop 0.25.1 (contracts 1.60 and 1.61: the join code beside the QR, the return link, the local-network words) in linux/packages-local, checked against the sha256 the release notes publish. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.25.1
SHA256=a5f5623ec97bf44e8667944d4a3ce38c7edbee1ef08713bbbef046e4b986fbb6
FILE=Kitepon.LoginBilling.Desktop.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
