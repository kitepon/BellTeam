#!/usr/bin/env python3
"""Authenticate one fixed runtime closure archive (Z-b2); never extract or execute it. Staging validates the manifest."""
import hashlib
import json
import os
import sys
import tarfile
from module_artifact_verifier import APP_ROOT, root_file, verify_signature
from web_gateway_artifact import require
from runtime_update import COMPONENTS

POLICY = dict(schema='bellteam.runtime.verification-policy.v1', repository='kitepon/BellTeam', repositoryId='1404510084',
              signerWorkflow='kitepon/BellTeam/.github/workflows/publish-runtime.yml', sourceRef='refs/heads/main',
              predicateType='https://slsa.dev/provenance/v1')


def authenticate(component, archive, bundle, trusted, policy, expectation, *, verify=verify_signature):
    require(component in COMPONENTS and policy == POLICY, 'RUNTIME_ARTIFACT_INVALID')
    require(type(expectation) is dict and set(expectation) == {'archiveSha256', 'sourceCommit', 'signerCommit'}, 'RUNTIME_ARTIFACT_INVALID')
    archive.seek(0)
    digest = hashlib.file_digest(archive, 'sha256').hexdigest()
    require(digest == expectation['archiveSha256'], 'RUNTIME_ARTIFACT_INVALID')
    verify(archive, bundle, trusted, policy, source=expectation['sourceCommit'], signer=expectation['signerCommit'])
    archive.seek(0)
    with tarfile.open(fileobj=archive, mode='r:gz') as tar:
        member = tar.next()
        # The publisher writes manifest.json first so authentication never scans the whole closure.
        require(member is not None and member.name == 'manifest.json' and member.isfile() and member.size <= 64 * 1024 * 1024, 'RUNTIME_ARTIFACT_INVALID')
        raw = tar.extractfile(member).read()
    return dict(schema='bellteam.runtime.verification.v1', component=component, archiveSha256=digest,
                manifestSha256=hashlib.sha256(raw).hexdigest(), manifest=json.loads(raw),
                verification=dict(method='github-oidc-attestation', repositoryId=policy['repositoryId']))


def main():
    require(len(sys.argv) == 5 and os.geteuid() == 0, 'RUNTIME_ARTIFACT_INVALID')
    component, archive_path, bundle_path, expectation_path = sys.argv[1:]
    with root_file(APP_ROOT / 'config/runtime-verification.json', 16384) as policy, \
         root_file(APP_ROOT / 'config/web-gateway-trusted-root.jsonl', 1024**2) as trusted, \
         root_file(expectation_path, 16384) as expectation, root_file(archive_path, 512 * 1024**2) as archive, \
         root_file(bundle_path, 16 * 1024**2) as bundle:
        print(json.dumps(authenticate(component, archive, bundle, trusted, json.load(policy), json.load(expectation)), separators=(',', ':')))


if __name__ == '__main__':
    try: main()
    except Exception:
        print('RUNTIME_VERIFICATION_FAILED', file=sys.stderr)
        raise SystemExit(1)
