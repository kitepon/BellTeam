#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.5.0 (.NET form of the Approval Box client component, release client-dotnet-v0.5.0) in android/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.5.0
SHA256=3a76125448262c81ed03889bdf9f0170c051b988e31a65279491af92ab76fd79
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
