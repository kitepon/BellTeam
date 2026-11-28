#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.8.0 (.NET form of the Approval Box client component, release client-dotnet-v0.8.0) in android/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.8.0
SHA256=fd8b155f9027eabb3b0c8fa16e6c2a05d10a025836f9ea800783a1e168d1784d
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
