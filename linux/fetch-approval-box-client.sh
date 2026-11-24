#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.5.3 (.NET form of the Approval Box client component, release client-dotnet-v0.5.3) in linux/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.5.3
SHA256=a1ecb32df13d27aff9527159b97d92747b7cf5caf4679e70e810881077d21b77
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
