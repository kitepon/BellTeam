#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.5.2 (.NET form of the Approval Box client component, release client-dotnet-v0.5.2) in android/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.5.2
SHA256=0e273d84a732424501227268c3c87b84e2ca6955c049d32fdee0fd5826cb58d9
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
