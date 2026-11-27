#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.6.2 (.NET form of the Approval Box client component, release client-dotnet-v0.6.2) in linux/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.6.2
SHA256=39084dc429704494f4832db12353ceed8f39dc255853362bfdf2c494d2ce26c4
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
