"""Fixed conversation content/catalog boundaries; no real crypto/native proof."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from web_gateway_artifact import contract, validate_manifest, write_archive, check_archive, sha256
from module_artifact_package import validate_conversation_source
from module_artifact_verifier import authenticate, policy_for
from update_catalog import validate_catalog, validate_conversation_archive

SOURCE = 'a' * 40

class ConversationArtifact(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.payload = self.root / 'payload'
        self.entry, self.runtime, required = contract('conversation')
        for name in [*(name.removeprefix('payload/') for name in required), 'node_modules/mock/package.json']:
            path = self.payload / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(name)
        state = self.payload / 'src/conversation/state-compatibility.mjs'; state.parent.mkdir(exist_ok=True)
        state.write_text('export const CONVERSATION_STATE_COMPATIBILITY = ' + json.dumps(self.runtime['stateCompatibility']))
        self.archive = self.root / 'conversation.tar.gz'
        self.manifest = write_archive(self.payload, self.archive, SOURCE, 'amd64', component='conversation')

    def test_fixed_entry_null_state_and_complete_inventory(self):
        self.assertEqual(self.entry, 'payload/src/conversation-entry.mjs')
        self.assertIsNone(self.runtime['stateSchema'])
        self.assertEqual(len(self.runtime['stateCompatibility']), 7)
        self.assertEqual(self.runtime['stateCompatibility']['imageMimeTypes'], ['image/png','image/jpeg','image/webp','image/gif'])
        with self.archive.open('rb') as file:
            manifest, _ = check_archive(file, SOURCE, 'amd64', component='conversation')
        self.assertEqual(manifest, self.manifest)
        with self.archive.open('rb') as file, self.assertRaises(ValueError): check_archive(file, component='members')
        again = self.root / 'again.tar.gz'; write_archive(self.payload, again, SOURCE, 'amd64', component='conversation')
        self.assertEqual(self.archive.read_bytes(), again.read_bytes())

    def test_durable_receipt_dependency_is_allowed_without_expanding_old_inventory(self):
        _, _, required = contract('conversation')
        self.assertEqual(len(required), 56)
        dependency = self.payload / 'src/direct-log-record.mjs'
        dependency.write_bytes((ROOT / 'src/direct-log-record.mjs').read_bytes())
        archive = self.root / 'durable-receipt.tar.gz'
        manifest = write_archive(self.payload, archive, SOURCE, 'amd64', component='conversation')
        with archive.open('rb') as stream:
            checked, _ = check_archive(stream, SOURCE, 'amd64', component='conversation')
        self.assertEqual(checked, manifest)
        sources = {row['path'] for row in checked['files'] if not row['path'].startswith('payload/node_modules/')}
        self.assertEqual(sources, required | {'payload/src/direct-log-record.mjs'})
        bad = copy.deepcopy(manifest)
        bad['files'].append(dict(path='payload/src/unregistered.mjs', bytes=0, sha256='0' * 64))
        with self.assertRaises(ValueError): validate_manifest(bad, component='conversation')

    def test_all_seven_values_order_types_and_unknown_fields_are_strict(self):
        changes = [lambda m:m.update(component='members'), lambda m:m.update(entry='payload/src/members-entry.mjs'),
                   lambda m:m['runtime'].update(stateSchema=1), lambda m:m['runtime'].pop('stateSchema'),
                   lambda m:m['runtime'].update(parentProtocol=True), lambda m:m['runtime'].update(extra=True)]
        for key, value in self.runtime['stateCompatibility'].items():
            changes.append(lambda m,k=key:m['runtime']['stateCompatibility'].pop(k))
            changes.append(lambda m,k=key,v=value:m['runtime']['stateCompatibility'].update({k:list(reversed(v)) if isinstance(v,list) else 'unknown'}))
        changes.append(lambda m:m['runtime']['stateCompatibility'].update(extra='unknown'))
        for change in changes:
            m=copy.deepcopy(self.manifest);change(m)
            with self.subTest(value=m), self.assertRaises(ValueError): validate_manifest(m, component='conversation')
        for name in ['unknown','conversation/other','../conversation']:
            with self.assertRaises(ValueError): contract(name)

    def test_missing_source_export_and_content_tampering_rejected(self):
        validate_conversation_source(self.payload)
        state = self.payload / 'src/conversation/state-compatibility.mjs'
        state.write_text('export const CONVERSATION_STATE_COMPATIBILITY = {}')
        with self.assertRaisesRegex(ValueError,'CONVERSATION_SOURCE_STATE_INCOMPATIBLE'): validate_conversation_source(self.payload)
        m=copy.deepcopy(self.manifest);m['files']=[f for f in m['files'] if not f['path'].endswith('state-compatibility.mjs')]
        with self.assertRaises(ValueError): validate_manifest(m, component='conversation')

    def test_literal_closure_missing_dependencies_are_rejected(self):
        _, _, required = contract('conversation')
        self.assertEqual(len(required), 56)
        for omitted in ['payload/src/module-ipc.mjs', 'payload/src/module-streams.mjs', 'payload/src/conversation/probe-fixture.json',
                        'payload/src/conversation/dispatcher.mjs', 'payload/src/observer-check.mjs',
                        'payload/src/usage/web-push-schema.mjs']:
            manifest = copy.deepcopy(self.manifest)
            manifest['files'] = [row for row in manifest['files'] if row['path'] != omitted]
            with self.subTest(path=omitted), self.assertRaises(ValueError):
                validate_manifest(manifest, component='conversation')
        self.assertNotIn('payload/src/conversation-lifetimes.mjs', required)
        self.assertNotIn('payload/src/run-seat-command.mjs', required)

    def test_fixed_channel_import_requires_shared_concurrency_module(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in contract('conversation')[2]:
                relative = name.removeprefix('payload/')
                target = root / relative; target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, target)
            command = ['node', '--input-type=module', '-e', 'await import(' + json.dumps((root / 'src/conversation-channel.mjs').as_uri()) + ')']
            present = subprocess.run(command, capture_output=True)
            self.assertEqual(present.returncode, 0, present.stderr.decode())
            (root / 'src/module-ipc.mjs').unlink()
            absent = subprocess.run(command, capture_output=True)
            self.assertNotEqual(absent.returncode, 0)
            self.assertIn(b'ERR_MODULE_NOT_FOUND', absent.stderr)

    def catalog(self):
        version=sha256(self.archive.read_bytes());url=f'https://github.com/kitepon/BellTeam/releases/download/updates-20261103T000000Z/conversation-{SOURCE}-linux-amd64.tar.gz'
        return dict(schema='bellteam.update-catalog.v1',publishedAt='2026-11-03T00:00:00Z',expiresAt='2026-11-04T00:00:00Z',revokedCatalogs=[],releases=[dict(componentId='conversation',sourceCommit=SOURCE,versionId=version,platform=dict(os='linux',arch='amd64'),artifact=dict(kind='archive',archive=dict(url=url,sha256=version,bytes=self.archive.stat().st_size),bundle=dict(url=url+'.sigstore.json',sha256='b'*64,bytes=100),signerCommit=SOURCE),compatibility=dict(nodeMajor=26,parentProtocol=1,stateSchema=None,containerUpdate=None,stateCompatibility=self.runtime['stateCompatibility']),changes=['Conversation module'])])

    def test_catalog_five_keys_and_archive_consumer_consistency(self):
        catalog=self.catalog();validate_catalog(catalog,now=1793664001)
        release=catalog['releases'][0];state=self.runtime['stateCompatibility']
        validate_conversation_archive(release,self.manifest,state)
        for key in release['compatibility']:
            c=copy.deepcopy(catalog);del c['releases'][0]['compatibility'][key]
            with self.assertRaises(ValueError):validate_catalog(c,now=1793664001)
        for mutate in [lambda c:c.update(extra=1),lambda c:c.update(nodeMajor='26'),lambda c:c.update(nodeMajor=True),lambda c:c.update(stateSchema=1),lambda c:c['stateCompatibility']['directRecordSchemas'].reverse()]:
            c=copy.deepcopy(catalog);mutate(c['releases'][0]['compatibility'])
            with self.assertRaises(ValueError):validate_catalog(c,now=1793664001)
        m=copy.deepcopy(self.manifest);m['sourceCommit']='b'*40
        with self.assertRaises(ValueError):validate_conversation_archive(release,m,state)
        with self.assertRaisesRegex(ValueError,'UPDATE_CONVERSATION_CONSUMER_UNSUPPORTED'):validate_conversation_archive(release,self.manifest,{})
        c=copy.deepcopy(catalog);c['releases'][0]['artifact']['archive']['sha256']='c'*64
        with self.assertRaises(ValueError):validate_catalog(c,now=1793664001)

    def test_formal_publication_uses_conversation_export_policy_and_archive(self):
        spec=importlib.util.spec_from_file_location('publication',ROOT/'scripts/check-update-catalog-publication.py')
        publication=importlib.util.module_from_spec(spec);spec.loader.exec_module(publication)
        release=self.catalog()['releases'][0]
        with patch('module_artifact_package.validate_conversation_source',return_value=self.runtime['stateCompatibility']) as state, \
             patch.object(publication,'download_asset',side_effect=[self.archive.read_bytes(),b'{}']), \
             patch('module_artifact_verifier.verify_signature') as official:
            publication.verify_conversation_release(release)
            state.assert_called_once_with(ROOT)
            args,kwargs=official.call_args
            self.assertEqual(args[3],policy_for('conversation'))
            self.assertEqual(kwargs,dict(source=SOURCE,signer=SOURCE))

    def test_dedicated_policy_and_same_snapshot_fds(self):
        policy=json.loads((ROOT/'config/conversation-verification.json').read_text());self.assertEqual(policy,policy_for('conversation'))
        bundle=self.root/'bundle.json';bundle.write_text('{}');trust=self.root/'trust';trust.write_text('{}')
        expectation=dict(archiveSha256=sha256(self.archive.read_bytes()),sourceCommit=SOURCE,signerCommit='b'*40)
        with self.archive.open('rb') as a,bundle.open('rb') as b,trust.open('rb') as t:
            def official(command,**kwargs):
                self.assertEqual(command[command.index('--signer-workflow')+1],'kitepon/BellTeam/.github/workflows/publish-conversation.yml')
                self.assertEqual(kwargs['pass_fds'],(a.fileno(),b.fileno(),t.fileno()))
                return subprocess.CompletedProcess(command,0,json.dumps([{'verificationResult':{'signature':{'certificate':{'sourceRepositoryIdentifier':'1404510084'}}}}]).encode(),b'')
            with patch('subprocess.check_output',return_value='26\n'),patch('subprocess.run',side_effect=official), \
                 patch('module_artifact_verifier.platform.machine',return_value='x86_64'):
                self.assertEqual(authenticate(a,b,t,policy,expectation,component='conversation')['schema'],'bellteam.conversation.verification.v1')
                with patch('module_artifact_verifier.platform.machine',return_value='aarch64'):
                    with self.assertRaisesRegex(ValueError,'GATEWAY_ARCH_MISMATCH'):
                        authenticate(a,b,t,policy,expectation,component='conversation')
            with patch('subprocess.check_output',return_value='26\n'),patch('subprocess.run') as call:
                with self.assertRaises(ValueError):authenticate(a,b,t,policy_for('members'),expectation,component='conversation')
                call.assert_not_called()

if __name__ == '__main__': unittest.main()
