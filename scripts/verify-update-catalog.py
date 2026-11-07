#!/usr/bin/env python3
"""Authenticate a fixed formal publisher's non-executable catalog; never adopt it."""
import argparse
import hashlib
from pathlib import Path
import sys
import os
from module_artifact_verifier import root_file, verify_signature
from update_catalog import MAX_CATALOG, POLICY, WORKFLOW, exact, hexadecimal, require, strict_json, validate_catalog, validate_runtime_catalog

APP_ROOT = Path(__file__).resolve().parents[1]


def authenticate(catalog, bundle, trusted, policy, expectation=None, *, now=None, runtime=False):
    require(policy == POLICY, 'UPDATE_CATALOG_POLICY_INVALID')
    catalog.seek(0)
    raw = catalog.read(MAX_CATALOG + 1)
    require(len(raw) <= MAX_CATALOG, 'UPDATE_CATALOG_TOO_LARGE')
    digest = hashlib.sha256(raw).hexdigest()
    source = signer = None
    if expectation is not None:
        exact(expectation, 'catalogSha256,sourceCommit,signerCommit')
        require(hexadecimal(expectation['catalogSha256'], 64) and hexadecimal(expectation['sourceCommit'], 40)
                and hexadecimal(expectation['signerCommit'], 40))
        require(expectation['catalogSha256'] == digest, 'UPDATE_CATALOG_DIGEST_MISMATCH')
        source, signer = expectation['sourceCommit'], expectation['signerCommit']
    verified = verify_signature(catalog, bundle, trusted, policy, source=source, signer=signer)
    identities = set()
    for proof in verified:
        result = proof['verificationResult']
        certificate = result['signature']['certificate']
        require(certificate['issuer'] == 'https://token.actions.githubusercontent.com'
                and certificate['sourceRepositoryIdentifier'] == '1404510084'
                and certificate['sourceRepositoryRef'] == 'refs/heads/main'
                and certificate['buildSignerURI'] == 'https://github.com/' + WORKFLOW + '@refs/heads/main'
                and certificate['runnerEnvironment'] == 'github-hosted', 'UPDATE_CATALOG_PUBLISHER_MISMATCH')
        actual_source, actual_signer = certificate['sourceRepositoryDigest'], certificate['buildSignerDigest']
        require(hexadecimal(actual_source, 40) and hexadecimal(actual_signer, 40))
        identities.add((actual_source, actual_signer))
        subjects = result['statement']['subject']
        require(type(subjects) is list and len(subjects) == 1 and subjects[0]['digest']['sha256'] == digest,
                'UPDATE_CATALOG_SUBJECT_MISMATCH')
    require(len(identities) == 1, 'UPDATE_CATALOG_AMBIGUOUS_PUBLISHER')
    actual_source, actual_signer = identities.pop()
    require(expectation is None or (actual_source, actual_signer) == (source, signer), 'UPDATE_CATALOG_PIN_MISMATCH')
    if runtime:
        # Same publisher and signature rules; freshness and revocation come from the main catalog it names.
        return dict(schema='bellteam.runtime-catalog.verification.v1', runtimeCatalogSha256=digest,
                    runtimeCatalog=validate_runtime_catalog(strict_json(raw)),
                    verification=dict(method='github-oidc-attestation', repositoryId='1404510084',
                                      sourceCommit=actual_source, signerCommit=actual_signer, signerWorkflow=WORKFLOW))
    value = validate_catalog(strict_json(raw), now=now)
    return dict(schema='bellteam.update-catalog.verification.v1', catalogSha256=digest, catalog=value,
                verification=dict(method='github-oidc-attestation', repositoryId='1404510084',
                                  sourceCommit=actual_source, signerCommit=actual_signer, signerWorkflow=WORKFLOW))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publisher', action='store_true')
    parser.add_argument('--runtime', action='store_true')
    parser.add_argument('catalog'); parser.add_argument('bundle'); parser.add_argument('expectation', nargs='?')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'UPDATE_CATALOG_ROOT_REQUIRED')
    require(args.publisher == (args.expectation is None), 'UPDATE_CATALOG_MODE_INVALID')
    with root_file(APP_ROOT / 'config/update-catalog-verification.json', 16384) as policy, \
         root_file(APP_ROOT / 'config/web-gateway-trusted-root.jsonl', 1024**2) as trusted, \
         root_file(args.catalog, MAX_CATALOG) as catalog, root_file(args.bundle, 16 * 1024**2) as bundle:
        expectation = None
        if args.expectation is not None:
            with root_file(args.expectation, 16384) as expected: expectation = strict_json(expected.read())
        print(__import__('json').dumps(authenticate(catalog, bundle, trusted, strict_json(policy.read()), expectation, runtime=args.runtime), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('UPDATE_CATALOG_VERIFICATION_FAILED', file=sys.stderr)
        raise SystemExit(1)
