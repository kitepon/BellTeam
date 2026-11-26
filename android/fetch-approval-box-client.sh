#!/bin/sh
# Puts Kitepon.ApprovalBox.Client 0.5.4 (.NET form of the Approval Box client component, release client-dotnet-v0.5.4) in android/packages-approval-box, checked against the sha256 of the release. A mismatch removes the file and fails.
set -eu
cd "$(dirname "$0")"
VERSION=0.5.4
SHA256=c064859bf1d710cb28158eb99db495cc2302e0ff64652f2e99a70b6028891474
FILE=Kitepon.ApprovalBox.Client.$VERSION.nupkg
mkdir -p packages-approval-box
gh release download "client-dotnet-v$VERSION" -R kitepon/approval-box-apps -p "$FILE" -D packages-approval-box --clobber
echo "$SHA256  packages-approval-box/$FILE" | sha256sum -c - || { rm -f "packages-approval-box/$FILE"; exit 1; }
