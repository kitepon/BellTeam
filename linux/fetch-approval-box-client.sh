#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.7.0 (.NET form of the Approval Box client component, release client-dotnet-v0.7.0) in linux/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.7.0
SHA256=70e30a25d25cfbf51af5a3f09c8ccb99266b85a580f5164724ef361c6b624d12
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
