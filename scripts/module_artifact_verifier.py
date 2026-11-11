#!/usr/bin/env python3
"""Authenticate root-staged fixed component bytes with the official GitHub verifier; never extract."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import tempfile
from web_gateway_artifact import MAX_ARCHIVE, MAX_BUNDLE, check_archive, contract, require

APP_ROOT = Path(__file__).resolve().parents[1]


def root_file(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    file = os.fdopen(fd, 'rb')
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                and not info.st_mode & 0o7022 and info.st_size <= maximum, 'GATEWAY_VERIFICATION_INPUT_UNTRUSTED')
        return file
    except BaseException:
        file.close()
        raise


def verify_signature(artifact_file, bundle, trusted, policy, *, source=None, signer=None):
    descriptors = (artifact_file.fileno(), bundle.fileno(), trusted.fileno())
    artifact, proof, roots = ['/proc/self/fd/' + str(fd) for fd in descriptors]
    with tempfile.TemporaryDirectory(prefix='bellteam-gateway-proof-', dir='/tmp') as stage:
        # gh selects the bundle parser by extension; the link keeps the inherited snapshot FD.
        alias = Path(stage) / 'bundle.json'
        alias.symlink_to(proof)
        proof = str(alias)
        command = ['/usr/bin/gh', 'attestation', 'verify', artifact,
            '--repo', policy['repository'], '--signer-workflow', policy['signerWorkflow'],
            '--source-ref', policy['sourceRef'], '--deny-self-hosted-runners',
            '--predicate-type', policy['predicateType'], '--bundle', proof, '--custom-trusted-root', roots, '--format', 'json']
        if source is not None: command += ['--source-digest', source]
        if signer is not None: command += ['--signer-digest', signer]
        result = subprocess.run(command,
            pass_fds=descriptors, capture_output=True, timeout=60, check=True,
            env={'PATH': '/usr/bin:/bin', 'GH_CONFIG_DIR': '/nonexistent', 'GH_HOST': 'github.com', 'GH_PROMPT_DISABLED': '1'})
    verified = json.loads(result.stdout)
    require(type(verified) is list and verified, 'GATEWAY_ATTESTATION_MISSING')
    for proof in verified:
        require(proof['verificationResult']['signature']['certificate']['sourceRepositoryIdentifier'] == policy['repositoryId'],
                'GATEWAY_REPOSITORY_ID_MISMATCH')
    return verified


def policy_for(component):
    contract(component)
    return dict(schema=f'bellteam.{component}.verification-policy.v1', repository='kitepon/BellTeam',
        repositoryId='1404510084', signerWorkflow=f'kitepon/BellTeam/.github/workflows/publish-{component}.yml',
        sourceRef='refs/heads/main', predicateType='https://slsa.dev/provenance/v1')


def authenticate(archive, bundle, trusted, policy, expectation, *, component='web-gateway'):
    contract(component)
    require(subprocess.check_output(['/usr/local/bin/node', '-p', 'process.versions.node.split(".")[0]'],
                                   env={'PATH': '/usr/bin:/bin'}, text=True).strip() == '26', 'GATEWAY_NODE_INCOMPATIBLE')
    require(set(expectation) == {'archiveSha256', 'sourceCommit', 'signerCommit'})
    for key, size in [('archiveSha256', 64), ('sourceCommit', 40), ('signerCommit', 40)]:
        require(isinstance(expectation[key], str) and re.fullmatch('[a-f0-9]{' + str(size) + '}', expectation[key]))
    archive.seek(0)
    digest = hashlib.file_digest(archive, 'sha256').hexdigest()
    require(digest == expectation['archiveSha256'], 'GATEWAY_ARCHIVE_DIGEST_MISMATCH')
    require(policy == policy_for(component))
    verify_signature(archive, bundle, trusted, policy, source=expectation['sourceCommit'], signer=expectation['signerCommit'])
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    require(platform.system() == 'Linux' and arch is not None, 'GATEWAY_PLATFORM_INVALID')
    state = None
    if component in ('memory', 'usage', 'diagnostics', 'execution', 'work-graph', 'lattice'):
        # Read trusted image code, never code from the supplied archive.
        module, exported = {
            'memory': ('memory/state-compatibility', 'MEMORY_STATE_COMPATIBILITY'),
            'usage': ('usage/state-compatibility', 'USAGE_STATE_COMPATIBILITY'),
            'diagnostics': ('diagnostics-protocol', 'DIAGNOSTICS_STATE_COMPATIBILITY'),
            'work-graph': ('work-graph-protocol', 'WORK_GRAPH_STATE_COMPATIBILITY'),
            'lattice': ('lattice-protocol', 'LATTICE_STATE_COMPATIBILITY'),
            'execution': ('execution-dispatcher', 'EXECUTION_STATE_COMPATIBILITY'),
        }[component]
        state = json.loads(subprocess.check_output(['/usr/local/bin/node', '--input-type=module', '-e',
            f'import {{ {exported} as s }} from "/app/src/{module}.mjs"; console.log(JSON.stringify(s))'],
            env={'PATH': '/usr/bin:/bin'}, text=True))
    # The trusted image JS export is the one state truth; the archive's manifest must equal it exactly.
    try: manifest, manifest_sha = check_archive(archive, expectation['sourceCommit'], arch, component=component, state=state)
    except ValueError as error:
        if state is not None and str(error) in ('MODULE_STATE_INVALID', 'MODULE_STATE_INCOMPATIBLE'):
            raise ValueError(component.upper().replace('-', '_') + '_IMAGE_STATE_INCOMPATIBLE') from error
        raise
    return dict(schema=f'bellteam.{component}.verification.v1', archiveSha256=digest,
        manifestSha256=manifest_sha, manifest=manifest,
        verification=dict(method='github-oidc-attestation', repositoryId=policy['repositoryId']))


def main(component):
    contract(component)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive'); parser.add_argument('bundle'); parser.add_argument('expectation')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'GATEWAY_ROOT_VERIFIER_REQUIRED')
    with root_file(APP_ROOT / f'config/{component}-verification.json', 16384) as policy_file, \
         root_file(APP_ROOT / 'config/web-gateway-trusted-root.jsonl', 1024**2) as trusted, \
         root_file(args.expectation, 16384) as expectation, root_file(args.archive, MAX_ARCHIVE) as archive, \
         root_file(args.bundle, MAX_BUNDLE) as bundle:
        result = authenticate(archive, bundle, trusted, json.load(policy_file), json.load(expectation), component=component)
    print(json.dumps(result, separators=(',', ':')))

