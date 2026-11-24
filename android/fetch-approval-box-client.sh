#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.1.2 (.NET form of the Approval Box client component, release client-dotnet-v0.1.2) in android/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.1.2
SHA256=a23d0795e58720c56ded45dd55abe57cf42709bfb487f63c97008682a61eeb69
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
