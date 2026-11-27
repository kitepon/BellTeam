#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.6.1 (.NET form of the Approval Box client component, release client-dotnet-v0.6.1) in android/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.6.1
SHA256=d2d1e7c1c46416b0bad99ee8dbd3d63d4e698dfbfc7da282fe2a2b4bacb65ec6
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
