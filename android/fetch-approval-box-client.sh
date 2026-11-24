#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.1.3 (.NET form of the Approval Box client component, release client-dotnet-v0.1.3) in android/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.1.3
SHA256=9a640e71e5c9b578d71dff9bc00e8af24d803b6b286cf426a3ecdb0ea17a1163
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
