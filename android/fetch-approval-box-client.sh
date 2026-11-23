#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.1.1 (.NET form of the Approval Box client component, release client-dotnet-v0.1.1) in android/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.1.1
SHA256=624609dc711da5d25c8b96349284dddebf7227002f55005e3cf41dd8d511e9fe
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
