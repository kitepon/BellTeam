import copy
import hashlib
import io
import json
from pathlib import Path
import platform
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from web_gateway_artifact import EXECUTION_FILES, check_archive, validate_manifest, write_archive
from update_catalog import validate_business_archive
import module_artifact_verifier as verifier


class ExecutionArtifact(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
        for name in EXECUTION_FILES:
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(name)
        self.archive = self.root / 'archive.tar.gz'
        write_archive(self.root / 'payload', self.archive, 'a' * 40, self.arch, component='execution')
        with self.archive.open('rb') as stream: self.manifest, _ = check_archive(stream, component='execution')

    def test_literal_asset_entry_and_string_state_are_required(self):
        self.assertEqual(len(EXECUTION_FILES), 46)
        changes = [lambda m: m.update(entry='payload/src/usage-entry.mjs'),
            lambda m: m.update(files=[r for r in m['files'] if r['path'] != 'payload/config/common-agents.md']),
            lambda m: m['files'].append(dict(path='payload/src/run-seat-command.mjs', bytes=0, sha256='b'*64)),
            lambda m: m['runtime'].update(stateCompatibility={'schema':'bellteam.execution-state.v1'}),
            lambda m: m['runtime'].update(stateSchema=1),
            lambda m: m['runtime'].update(parentProtocol=2)]
        for change in changes:
            value=copy.deepcopy(self.manifest); change(value)
            with self.subTest(change=change), self.assertRaises(ValueError): validate_manifest(value, component='execution')
        with self.assertRaises(ValueError): validate_manifest(self.manifest, 'b'*40, component='execution')
        with self.assertRaises(ValueError): validate_manifest(self.manifest, arch='unknown', component='execution')

    def test_inventory_content_tamper_rejected(self):
        altered=self.root/'altered.tar.gz'
        with tarfile.open(self.archive,'r:gz') as source, tarfile.open(altered,'w:gz') as target:
            for member in source:
                body=source.extractfile(member).read()
                if member.name=='payload/config/common-agents.md': body=b'x'*len(body)
                target.addfile(member,io.BytesIO(body))
        with altered.open('rb') as stream, self.assertRaisesRegex(ValueError,'GATEWAY_CONTENT_CHANGED'):
            check_archive(stream,component='execution')

    def test_catalog_matches_source_arch_and_actual_string(self):
        release=dict(componentId='execution',sourceCommit='a'*40,platform=dict(os='linux',arch=self.arch),
            compatibility=dict(nodeMajor=26,parentProtocol=1,stateSchema=None,containerUpdate=None,stateCompatibility='bellteam.execution-state.v1'))
        validate_business_archive(release,self.manifest,'bellteam.execution-state.v1')
        for state in [{},'other',None]:
            with self.assertRaises(ValueError): validate_business_archive(release,self.manifest,state)
        with self.assertRaises(ValueError): validate_business_archive({**release,'sourceCommit':'b'*40},self.manifest,'bellteam.execution-state.v1')

    def test_verifier_uses_trusted_image_after_signature_and_rejects_disagreement(self):
        expected=dict(archiveSha256=hashlib.sha256(self.archive.read_bytes()).hexdigest(),sourceCommit='a'*40,signerCommit='a'*40)
        commands=[]
        def output(command,**_):
            commands.append(command)
            return '26\n' if '-p' in command else json.dumps('bellteam.execution-state.v1')
        with self.archive.open('rb') as a, self.archive.open('rb') as b, self.archive.open('rb') as t, patch.object(verifier,'verify_signature') as sig, patch.object(verifier.subprocess,'check_output',side_effect=output):
            self.assertEqual(verifier.authenticate(a,b,t,verifier.policy_for('execution'),expected,component='execution')['manifest'],self.manifest)
            sig.assert_called_once()
            self.assertIn('/app/src/execution-dispatcher.mjs',commands[-1][-1])
        with self.archive.open('rb') as a, self.archive.open('rb') as b, self.archive.open('rb') as t, patch.object(verifier,'verify_signature'), patch.object(verifier.subprocess,'check_output',side_effect=['26\n',json.dumps({})]):
            with self.assertRaisesRegex(ValueError,'EXECUTION_IMAGE_STATE_INCOMPATIBLE'):
                verifier.authenticate(a,b,t,verifier.policy_for('execution'),expected,component='execution')


if __name__=='__main__': unittest.main()
