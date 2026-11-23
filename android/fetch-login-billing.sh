#!/bin/sh
# Puts Kitepon.LoginBilling.Android 0.19.3 in android/packages-local, checked against the sha256 Mint published (a485). A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.19.3
SHA256=fa11250a3cb786538b69a412e19ae8753bcc396bb1bac99044841a9eefa8f35b
FILE=Kitepon.LoginBilling.Android.$VERSION.nupkg
mkdir -p packages-local
gh release download "v$VERSION" -R kitepon/login-billing -p "$FILE" -D packages-local --clobber
echo "$SHA256  packages-local/$FILE" | sha256sum -c - || { rm -f "packages-local/$FILE"; exit 1; }
