"""Members content and verifier wiring, not real cryptographic proof."""
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from web_gateway_artifact import check_archive, contract, sha256, validate_manifest, write_archive
from module_artifact_verifier import authenticate
ARCH = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
SOURCE = 'a' * 40


class MembersArtifactTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.payload = self.root / 'payload'
        for name in ['src/members-entry.mjs', 'package.json', 'package-lock.json', 'node_modules/jose/package.json', 'config/common-agents.md', 'src/members/state-compatibility.mjs']:
            path = self.payload / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name + '\n')
        self.archive = self.root / 'members.tar.gz'
        self.manifest = write_archive(self.payload, self.archive, SOURCE, ARCH, component='members')

    def test_minimal_self_contained_members_without_web_is_deterministic(self):
        again = self.root / 'again.tar.gz'
        write_archive(self.payload, again, SOURCE, ARCH, component='members')
        self.assertEqual(self.archive.read_bytes(), again.read_bytes())
        with self.archive.open('rb') as stream:
            manifest, digest = check_archive(stream, SOURCE, ARCH, component='members')
        self.assertEqual(manifest, self.manifest)
        self.assertEqual(manifest['schema'], 'bellteam.members.artifact.v1')
        self.assertEqual(manifest['runtime']['stateCompatibility']['botProfileSchema'], 'bellteam.bot.v8')
        self.assertEqual(len(digest), 64)
        self.assertEqual(len(manifest['files']), 6)
        self.assertIn('payload/node_modules/jose/package.json', [f['path'] for f in manifest['files']])

    def test_web_component_and_nonexact_state_contracts_are_rejected(self):
        for change in [lambda m: m.update(component='web-gateway'),
                       lambda m: m.update(schema='bellteam.web-gateway.artifact.v1'),
                       lambda m: m.update(entry='payload/src/http-gateway-entry.mjs'),
                       lambda m: m['runtime'].pop('stateCompatibility'),
                       lambda m: m['runtime'].update(stateCompatibility={}),
                       lambda m: m['runtime']['stateCompatibility'].update(botProfileSchema='bellteam.bot.v9'),
                       lambda m: m['runtime']['stateCompatibility'].update(unknown='v1'),
                       lambda m: m['runtime'].update(stateSchema=2),
                       lambda m: m['runtime'].update(stateSchema=True),
                       lambda m: m['runtime'].update(parentProtocol=2),
                       lambda m: m['runtime'].update(nodeMajor=27),
                       lambda m: m.update(policy={'allowUnsigned': True}),
                       lambda m: m.update(files=m['files'][:-1])]:
            value = json.loads(json.dumps(self.manifest)); change(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_manifest(value, SOURCE, ARCH, component='members')
        with self.archive.open('rb') as stream, self.assertRaises(ValueError):
            check_archive(stream, SOURCE, ARCH)
        for component in ['notifications/members', 'unknown', '../members', 'web-gateway/members']:
            with self.assertRaisesRegex(ValueError, 'MODULE_COMPONENT_INVALID'):
                contract(component)

    def test_members_policy_pins_workflow_and_fd_snapshot(self):
        policy = json.loads((ROOT / 'config/members-verification.json').read_text())
        web_policy = json.loads((ROOT / 'config/web-gateway-verification.json').read_text())
        expectation = dict(archiveSha256=sha256(self.archive.read_bytes()), sourceCommit=SOURCE, signerCommit='b' * 40)
        bundle = self.root / 'bundle.json'; bundle.write_text('{}')
        trusted = self.root / 'trusted'; trusted.write_text('{}')
        proof = [{'verificationResult': {'signature': {'certificate': {'sourceRepositoryIdentifier': '1404510084'}}}}]
        with self.archive.open('rb') as a, bundle.open('rb') as b, trusted.open('rb') as t:
            aliases = []
            def official(command, **options):
                for flag, value in [('--signer-workflow', 'kitepon/BellTeam/.github/workflows/publish-members.yml'),
                                    ('--source-digest', SOURCE), ('--signer-digest', 'b' * 40)]:
                    self.assertEqual(command[command.index(flag) + 1], value)
                self.assertEqual(options['pass_fds'], (a.fileno(), b.fileno(), t.fileno()))
                self.assertNotIn('GH_TOKEN', options['env'])
                alias = Path(command[command.index('--bundle') + 1]); aliases.append(alias)
                self.assertEqual(alias.stat().st_ino, bundle.stat().st_ino)
                return subprocess.CompletedProcess(command, 0, json.dumps(proof).encode(), b'')
            with patch('subprocess.check_output', return_value='26\n'), patch('subprocess.run', side_effect=official):
                result = authenticate(a, b, t, policy, expectation, component='members')
                self.assertEqual(result['schema'], 'bellteam.members.verification.v1')
                self.assertEqual(result['manifest'], self.manifest)
            self.assertTrue(aliases and all(not alias.parent.exists() for alias in aliases))
            with patch('subprocess.check_output', return_value='26\n'), patch('subprocess.run') as run:
                for bad_policy in [web_policy, {**policy, 'signerWorkflow': web_policy['signerWorkflow']}]:
                    with self.assertRaises(ValueError):
                        authenticate(a, b, t, bad_policy, expectation, component='members')
                run.assert_not_called()

    def test_source_export_must_match_exact_state_formats(self):
        from module_artifact_package import validate_members_source
        state = self.payload / 'src/members/state-compatibility.mjs'
        state.write_text('export const MEMBERS_STATE_COMPATIBILITY = '+json.dumps(self.manifest['runtime']['stateCompatibility']))
        validate_members_source(self.payload)
        state.write_text('export const MEMBERS_STATE_COMPATIBILITY = {}')
        with self.assertRaisesRegex(ValueError, 'MEMBERS_SOURCE_STATE_INCOMPATIBLE'):
            validate_members_source(self.payload)

    def test_probe_refuses_shared_paths_and_seeds_only_empty_existing_formats(self):
        spec = importlib.util.spec_from_file_location('members_probe', ROOT / 'test/helpers/members-artifact-probe.py')
        probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
        with patch('os.geteuid', return_value=1000), self.assertRaisesRegex(ValueError, 'MEMBERS_PROBE_ROOT_REQUIRED'):
            probe.clean_runner()
        with patch('os.geteuid', return_value=0), patch.object(probe, 'APP', self.root), self.assertRaisesRegex(ValueError, 'MEMBERS_PROBE_REQUIRES_CLEAN_RUNNER'):
            probe.clean_runner()
        with patch('os.readlink', return_value='mnt:[same]'), self.assertRaisesRegex(ValueError, 'MEMBERS_PROBE_PRIVATE_MOUNT_NAMESPACE_REQUIRED'):
            probe.private_mount_namespace()
        prefix=self.root / 'state-prefix'; prefix.mkdir(); created=[]
        with patch.object(probe, 'STATE', prefix), patch('os.chown') as chown:
            probe.seed_members_state(created)
        self.assertTrue(all(call.args[1:] == (1001,1001) for call in chown.call_args_list))
        self.assertEqual(len(chown.call_args_list),6)
        self.assertEqual([x.name for x in (prefix/'state/bots').iterdir()],['.initialized'])
        self.assertEqual((prefix/'state/bots/.initialized').read_bytes(),b'')
        self.assertEqual((prefix/'owner/user-rules.md').read_bytes(),b'')
        self.assertEqual(json.loads((prefix/'owner/profile.json').read_text()),dict(schema='bellteam.owner-profile.v1',name='fixture',profile='',avatar='',xUrl='',githubUrl='',links=[]))
        self.assertFalse((prefix/'state/.transaction').exists())
        for path in created:
            self.assertEqual(path.stat().st_mode & 0o7777, 0o700 if path.is_dir() else 0o600)

    @unittest.skipIf(os.geteuid() == 0, 'Import regression stops at the unprivileged environment guard')
    def test_parent_probe_resolves_staged_production_dependencies(self):
        spec = importlib.util.spec_from_file_location('members_probe', ROOT / 'test/helpers/members-artifact-probe.py')
        helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
        checkout = self.root / 'checkout'; payload = self.root / 'app'
        for root in [checkout, payload]:
            shutil.copytree(ROOT / 'src', root / 'src')
        (checkout / 'scripts').mkdir()
        original = ROOT / 'scripts/probe-members-runtime.mjs'
        shutil.copyfile(original, checkout / 'scripts' / original.name)
        for name in ['package.json', 'package-lock.json']:
            shutil.copyfile(ROOT / name, payload / name)
        subprocess.run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
                       cwd=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=180)
        def execute(path):
            return subprocess.run(['node', str(path)], cwd='/', stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        before = execute(checkout / 'scripts' / original.name)
        self.assertNotEqual(before.returncode, 0)
        self.assertIn(b"Cannot find package 'croner'", before.stderr)
        with patch.object(helper, 'ROOT', checkout), patch.object(helper, 'APP', payload):
            staged = helper.stage_parent_probe()
        self.assertEqual(staged.read_bytes(), original.read_bytes())
        after = execute(staged)
        self.assertNotEqual(after.returncode, 0)
        self.assertIn(b'MEMBERS_PROBE_ENVIRONMENT', after.stderr)
        self.assertNotIn(b'ERR_MODULE_NOT_FOUND', after.stderr)
        self.assertEqual(after.stdout, b'')
        self.assertFalse((checkout / 'node_modules').exists())

    def catalog(self):
        version=sha256(self.archive.read_bytes());url=f'https://github.com/kitepon/BellTeam/releases/download/updates-20261103T000000Z/members-{SOURCE}-linux-{ARCH}.tar.gz'
        return dict(schema='bellteam.update-catalog.v1',publishedAt='2026-11-03T00:00:00Z',expiresAt='2026-11-04T00:00:00Z',revokedCatalogs=[],releases=[dict(componentId='members',sourceCommit=SOURCE,versionId=version,platform=dict(os='linux',arch=ARCH),artifact=dict(kind='archive',archive=dict(url=url,sha256=version,bytes=self.archive.stat().st_size),bundle=dict(url=url+'.sigstore.json',sha256='b'*64,bytes=100),signerCommit=SOURCE),compatibility=dict(nodeMajor=26,parentProtocol=1,stateSchema=None,containerUpdate=None,stateCompatibility=self.manifest['runtime']['stateCompatibility']),changes=['fixture'])])

    def test_members_catalog_five_keys_and_legacy_four_keys_are_strict(self):
        from update_catalog import validate_catalog
        from datetime import datetime,timezone
        now=datetime(2026,11,3,1,tzinfo=timezone.utc).timestamp()
        self.assertEqual(validate_catalog(self.catalog(),now=now)['releases'][0]['componentId'],'members')
        changes=[lambda c:c.pop('stateCompatibility'),lambda c:c.update(extra=1),lambda c:c.update(stateCompatibility=None),lambda c:c.update(stateCompatibility={}),lambda c:c['stateCompatibility'].pop('initializedMarker'),lambda c:c['stateCompatibility'].update(extra='v1'),lambda c:c['stateCompatibility'].update(botProfileSchema='bellteam.bot.v9'),lambda c:c.update(nodeMajor='26'),lambda c:c.update(parentProtocol=True),lambda c:c.update(stateSchema=1),lambda c:c.update(containerUpdate=1)]
        for change in changes:
            catalog=json.loads(json.dumps(self.catalog()));change(catalog['releases'][0]['compatibility'])
            with self.subTest(catalog=catalog),self.assertRaises(ValueError):validate_catalog(catalog,now=now)
        for component in ['container','web-gateway','notifications']:
            catalog=json.loads(json.dumps(self.catalog()));release=catalog['releases'][0];release['componentId']=component;release['compatibility'].pop('stateCompatibility')
            if component=='container':
                release['versionId']='sha256:'+'c'*64;release['artifact']=dict(kind='oci-index',reference='ghcr.io/kitepon/bellteam-server@'+release['versionId'])
            else:
                for kind in ['archive','bundle']:release['artifact'][kind]['url']=release['artifact'][kind]['url'].replace('/members-','/'+component+'-')
            if component == 'notifications':
                release['compatibility'].update(parentProtocol=2, stateSchema=2)
            validate_catalog(catalog,now=now)
            release['compatibility']['stateCompatibility']=self.manifest['runtime']['stateCompatibility']
            with self.subTest(component=component),self.assertRaises(ValueError):validate_catalog(catalog,now=now)
        catalog=self.catalog();catalog['releases'][0]['componentId']='future-component'
        with self.assertRaises(ValueError):validate_catalog(catalog,now=now)

    def test_catalog_archive_and_consumer_must_match_and_asset_hash_is_checked(self):
        from update_catalog import validate_members_archive
        release=self.catalog()['releases'][0];state=self.manifest['runtime']['stateCompatibility']
        validate_members_archive(release,self.manifest,state)
        for change in [lambda m:m.update(sourceCommit='b'*40),lambda m:m['runtime'].update(arch='arm64' if ARCH=='amd64' else 'amd64'),lambda m:m['runtime']['stateCompatibility'].update(userRulesEncoding='utf16')]:
            manifest=json.loads(json.dumps(self.manifest));change(manifest)
            with self.assertRaises(ValueError):validate_members_archive(release,manifest,state)
        for unknown in [{},{**state,'extra':'v1'},{**state,'botProfileSchema':'bellteam.bot.v9'}]:
            with self.assertRaisesRegex(ValueError,'UPDATE_MEMBERS_CONSUMER_UNSUPPORTED'):validate_members_archive(release,self.manifest,unknown)
        spec=importlib.util.spec_from_file_location('members_publication',ROOT/'scripts/check-update-catalog-publication.py');publication=importlib.util.module_from_spec(spec);spec.loader.exec_module(publication)
        data=b'fixed archive';expected=dict(url=release['artifact']['archive']['url'],bytes=len(data),sha256=sha256(data))
        with patch('module_artifact_package.validate_members_source',return_value=state), patch('module_artifact_verifier.verify_signature') as official, patch.object(publication,'download_asset',side_effect=[self.archive.read_bytes(),b'{}']):
            publication.verify_members_release(release)
            self.assertEqual(official.call_args.kwargs,dict(source=SOURCE,signer=SOURCE))
            self.assertEqual(official.call_args.args[3]['signerWorkflow'],'kitepon/BellTeam/.github/workflows/publish-members.yml')
        with patch.object(publication,'download',return_value=data):
            self.assertEqual(publication.download_asset(expected),data)
            for wrong in [{**expected,'sha256':'0'*64},{**expected,'bytes':len(data)+1}]:
                with self.assertRaisesRegex(ValueError,'UPDATE_RELEASE_CONTENT_MISMATCH'):publication.download_asset(wrong)

    def test_unsigned_fixed_cli_does_not_claim_authentication(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/verify-members.py'),
                                 str(self.archive), str(self.archive), str(self.archive)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'')
        self.assertIn(b'MEMBERS_VERIFICATION_FAILED', result.stderr)


if __name__ == '__main__':
    unittest.main()
