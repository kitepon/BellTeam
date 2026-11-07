"""Formal metadata validation and mocked verifier identity, never signing or publication."""
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
from contextlib import redirect_stdout
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from update_catalog import POLICY, WORKFLOW, publication_candidates, strict_json, validate_catalog
spec = importlib.util.spec_from_file_location('catalog_verifier', ROOT / 'scripts/verify-update-catalog.py')
verify = importlib.util.module_from_spec(spec); spec.loader.exec_module(verify)
NOW = datetime(2026, 11, 3, tzinfo=timezone.utc).timestamp()
SOURCE = 'a' * 40
SIGNER = 'b' * 40


def fixture():
    return dict(schema='bellteam.update-catalog.v1', publishedAt='2026-11-03T00:00:00Z', expiresAt='2026-11-10T00:00:00Z',
        revokedCatalogs=[], releases=[dict(componentId='container', sourceCommit=SOURCE,
        versionId='sha256:' + 'c' * 64, platform=dict(os='linux', arch='amd64'),
        artifact=dict(kind='oci-index', reference='ghcr.io/kitepon/bellteam-server@sha256:' + 'c' * 64),
        compatibility=dict(nodeMajor=None, parentProtocol=None, stateSchema=None, containerUpdate=None),
        changes=['公開済みの修理。'])])


class CatalogTest(unittest.TestCase):
    def test_formal_fixed_target_keeps_unknown_compatibility(self):
        value = fixture()
        self.assertIs(validate_catalog(value, now=NOW), value)
        self.assertIsNone(value['releases'][0]['compatibility']['containerUpdate'])

    def test_expired_overlong_future_and_unknown_keys_reject(self):
        for mutate in [lambda v: v.update(expiresAt='2026-11-02T00:00:00Z'),
                       lambda v: v.update(expiresAt='2026-11-10T00:00:01Z'),
                       lambda v: v.update(publishedAt='2026-11-03T00:05:01Z'),
                       lambda v: v.update(currentVersion='invented'),
                       lambda v: v['releases'][0]['compatibility'].update(containerUpdate=True),
                       lambda v: v['releases'][0]['artifact'].update(reference='evil.example/image:latest'),
                       lambda v: v['releases'].append(v['releases'][0]),
                       lambda v: v.update(revokedCatalogs=['d' * 64, 'd' * 64])]:
            value = fixture(); mutate(value)
            with self.subTest(value=value), self.assertRaises(ValueError): validate_catalog(value, now=NOW)
        with self.assertRaisesRegex(ValueError, 'UPDATE_CATALOG_EXPIRED'):
            validate_catalog(fixture(), now=NOW + 7 * 86400)
        with self.assertRaisesRegex(ValueError, 'UPDATE_CATALOG_DUPLICATE_KEY'):
            strict_json('{"schema":"one","schema":"two"}')

    def test_module_locator_is_same_repo_and_hash_bound(self):
        value = fixture(); release = value['releases'][0]
        url = 'https://github.com/kitepon/BellTeam/releases/download/updates-20261103T000000Z/notifications-' + SOURCE + '-linux-amd64.tar.gz'
        release.update(componentId='notifications', versionId='c' * 64,
            artifact=dict(kind='archive', signerCommit=SIGNER, archive=dict(url=url, bytes=42, sha256='c' * 64),
                          bundle=dict(url=url+'.sigstore.json', bytes=41, sha256='d' * 64)),
            compatibility=dict(nodeMajor=26, parentProtocol=2, stateSchema=2, containerUpdate=None))
        validate_catalog(value, now=NOW)
        for bad in ['http://github.com/evil', url.replace('kitepon/BellTeam', 'evil/fork'), url + '?redirect=evil']:
            release['artifact']['archive']['url'] = bad
            with self.assertRaises(ValueError): validate_catalog(value, now=NOW)

    def test_runtime_rows_need_the_fixed_ids_and_exact_runtime_contract(self):
        value = fixture(); release = value['releases'][0]
        url = 'https://github.com/kitepon/BellTeam/releases/download/updates-20261108T000000Z/runtime-codex-' + SOURCE + '-linux-amd64.tar.gz'
        release.update(componentId='runtime-codex', versionId='c' * 64,
            artifact=dict(kind='archive', signerCommit=SIGNER, archive=dict(url=url, bytes=42, sha256='c' * 64),
                          bundle=dict(url=url+'.sigstore.json', bytes=41, sha256='d' * 64)),
            compatibility=dict(runtimeProtocol=1, nodeMajor=26, libc='glibc'))
        validate_catalog(value, now=NOW)
        for bad in [dict(componentId='runtime-npm'), dict(compatibility=dict(runtimeProtocol=1, nodeMajor=26, libc='glibc', rollbackSafe=True))]:
            broken = __import__('copy').deepcopy(value); broken['releases'][0].update(bad)
            with self.assertRaises(ValueError): validate_catalog(broken, now=NOW)

    def test_api_fields_are_only_selectors_and_never_urls_to_trust(self):
        record = dict(draft=False, prerelease=False, tag_name='updates-20261103T000000Z',
                      assets=[{'name':'catalog.json','browser_download_url':'http://evil'}, {'name':'catalog.json.sigstore.json'}])
        candidates = publication_candidates([record])
        self.assertEqual(len(candidates), 1)
        self.assertTrue(candidates[0]['catalogUrl'].startswith('https://github.com/kitepon/BellTeam/releases/download/'))
        self.assertNotIn('sourceCommit', candidates[0])
        for bad in [{**record, 'draft':True}, {**record, 'prerelease':True}, {**record, 'tag_name':'main'}]:
            self.assertEqual(publication_candidates([bad]), [])

    def test_publisher_and_pin_use_only_successful_certificate_subject(self):
        raw = json.dumps(fixture()).encode(); digest = hashlib.sha256(raw).hexdigest()
        certificate = dict(issuer='https://token.actions.githubusercontent.com', sourceRepositoryIdentifier='1404510084', sourceRepositoryRef='refs/heads/main',
            buildSignerURI='https://github.com/'+WORKFLOW+'@refs/heads/main', runnerEnvironment='github-hosted',
            sourceRepositoryDigest=SOURCE, buildSignerDigest=SIGNER)
        proof = [{'verificationResult': dict(signature=dict(certificate=certificate), statement=dict(subject=[dict(digest=dict(sha256=digest))]))}]
        expected = dict(catalogSha256=digest, sourceCommit=SOURCE, signerCommit=SIGNER)
        with patch.object(verify, 'verify_signature', return_value=proof) as official:
            result = verify.authenticate(io.BytesIO(raw), None, None, POLICY, now=NOW)
            self.assertEqual(result['verification']['sourceCommit'], SOURCE)
            self.assertIsNone(official.call_args.kwargs['source'])
            self.assertIsNone(official.call_args.kwargs['signer'])
            verify.authenticate(io.BytesIO(raw), None, None, POLICY, expected, now=NOW)
            self.assertEqual(official.call_args.kwargs, dict(source=SOURCE, signer=SIGNER))
            with self.assertRaisesRegex(ValueError, 'UPDATE_CATALOG_PIN_MISMATCH'):
                verify.authenticate(io.BytesIO(raw), None, None, POLICY, {**expected,'signerCommit':'e'*40}, now=NOW)
            certificate['sourceRepositoryIdentifier'] = 'foreign'
            with self.assertRaises(ValueError): verify.authenticate(io.BytesIO(raw), None, None, POLICY, now=NOW)
            certificate['sourceRepositoryIdentifier'] = '1404510084'
            proof[0]['verificationResult']['statement']['subject'][0]['digest']['sha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'UPDATE_CATALOG_SUBJECT_MISMATCH'):
                verify.authenticate(io.BytesIO(raw), None, None, POLICY, now=NOW)
        with patch.object(verify, 'verify_signature') as official:
            with self.assertRaisesRegex(ValueError, 'UPDATE_CATALOG_POLICY_INVALID'):
                verify.authenticate(io.BytesIO(raw), None, None, {**POLICY, 'signerWorkflow':'evil'}, now=NOW)
            official.assert_not_called()


    def test_publication_preflight_binds_stable_index_and_architecture_source(self):
        spec = importlib.util.spec_from_file_location('catalog_publication', ROOT / 'scripts/check-update-catalog-publication.py')
        publication = importlib.util.module_from_spec(spec); spec.loader.exec_module(publication)
        config = json.dumps({'config':{'Labels':{'org.opencontainers.image.revision':SOURCE}}}).encode()
        config_digest = 'sha256:'+hashlib.sha256(config).hexdigest()
        manifest = json.dumps({'config':{'digest':config_digest}}).encode()
        manifest_digest = 'sha256:'+hashlib.sha256(manifest).hexdigest()
        index = json.dumps({'manifests':[{'platform':{'os':'linux','architecture':'amd64'},'digest':manifest_digest}]}).encode()
        value = fixture(); release = value['releases'][0]
        release['versionId'] = 'sha256:'+hashlib.sha256(index).hexdigest()
        release['artifact']['reference'] = 'ghcr.io/kitepon/bellteam-server@'+release['versionId']
        def fetch(url, headers=None):
            if 'token?' in url: return b'{"token":"fixture"}'
            if url.endswith('manifests/latest'): return index
            if url.endswith(manifest_digest): return manifest
            if url.endswith(config_digest): return config
            raise AssertionError(url)
        with patch.object(Path, 'read_bytes', return_value=json.dumps(value).encode()), \
             patch.object(publication, 'download', side_effect=fetch), \
             patch.object(publication, 'validate_catalog', side_effect=lambda v: validate_catalog(v,now=NOW)), redirect_stdout(io.StringIO()) as output:
            publication.main()
            self.assertEqual(json.loads(output.getvalue())['tag'], 'updates-20261103T000000Z')
            release['sourceCommit'] = 'e'*40
            with patch.object(Path, 'read_bytes', return_value=json.dumps(value).encode()), self.assertRaises(ValueError):
                publication.main()


if __name__ == '__main__':
    unittest.main()
