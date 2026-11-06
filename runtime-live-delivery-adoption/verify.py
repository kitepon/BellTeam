#!/usr/bin/env python3
"""Authenticate the closed live-delivery sidecar with the existing execution OIDC policy."""
import argparse
import json
import os
from pathlib import Path
import sys
import stat
import re

from package import inspect_archive, require

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / 'scripts'))


def caller_file(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    file = os.fdopen(fd, 'rb')
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1
                and not info.st_mode & 0o7022 and 0 < info.st_size <= maximum, 'LIVE_SIGNATURE_INPUT_UNTRUSTED')
        return file
    except BaseException:
        file.close()
        raise


def main():
    from module_artifact_verifier import verify_signature, policy_for
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path); parser.add_argument('bundle', type=Path)
    parser.add_argument('--source', required=True); parser.add_argument('--signer', required=True)
    parser.add_argument('--arch', required=True, choices=['amd64', 'arm64'])
    args = parser.parse_args()
    require(re.fullmatch('[a-f0-9]{40}', args.source) and args.source == args.signer, 'LIVE_SIGNATURE_SOURCE_CHANGED')
    with caller_file(args.archive, 2 * 1024 * 1024) as archive, caller_file(args.bundle, 16 * 1024 * 1024) as bundle, \
            caller_file(REPO / 'config/execution-verification.json', 16384) as policy, \
            caller_file(REPO / 'config/web-gateway-trusted-root.jsonl', 1024 * 1024) as roots:
        expected = policy_for('execution')
        require(json.load(policy) == expected, 'LIVE_SIGNATURE_POLICY_CHANGED')
        verify_signature(archive, bundle, roots, expected, source=args.source, signer=args.signer)
        # Inspect the same no-follow open descriptor authenticated above.
        result = inspect_archive(Path('/proc/self/fd/' + str(archive.fileno())), args.source, args.arch)
    print(json.dumps(dict(schema='bellteam.live-delivery-verification.v1', sourceCommit=args.source,
                         signerCommit=args.signer, archiveSha256=result['archiveSha256'],
                         manifestSha256=result['manifestSha256'], platform=result['platform'],
                         verification=dict(method='github-oidc-attestation', repositoryId=expected['repositoryId'])), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('LIVE_SIDECAR_VERIFICATION_FAILED', file=sys.stderr)
        raise SystemExit(1)
