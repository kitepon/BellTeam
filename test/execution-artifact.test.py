import copy
import hashlib
import io
import importlib.util
import json
from pathlib import Path
import platform
import subprocess
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
        self.assertEqual(len(EXECUTION_FILES), 55)
        changes = [lambda m: m.update(entry='payload/src/usage-entry.mjs'),
            lambda m: m.update(files=[r for r in m['files'] if r['path'] != 'payload/src/execution-dispatcher.mjs']),
            lambda m: m.update(files=[r for r in m['files'] if r['path'] != 'payload/package.json']),
            lambda m: m['runtime'].update(stateCompatibility={'schema':'bellteam.execution-state.v1'}),
            lambda m: m['runtime'].update(stateSchema=1),
            lambda m: m['runtime'].update(parentProtocol=2)]
        for change in changes:
            value=copy.deepcopy(self.manifest); change(value)
            with self.subTest(change=change), self.assertRaises(ValueError): validate_manifest(value, component='execution')
        with self.assertRaises(ValueError): validate_manifest(self.manifest, 'b'*40, component='execution')
        with self.assertRaises(ValueError): validate_manifest(self.manifest, arch='unknown', component='execution')

    def test_reader_accepts_the_modules_own_signed_file_list(self):
        legacy48 = copy.deepcopy(self.manifest)
        legacy48['files'] = [row for row in legacy48['files']
            if row['path'] not in {'payload/src/aiterm-hooks.mjs', 'payload/src/model-handoff.mjs'}]
        legacy47 = copy.deepcopy(legacy48)
        legacy47['files'] = [row for row in legacy47['files']
            if row['path'] != 'payload/src/automatic-configuration-application.mjs']
        for manifest in [legacy47, legacy48, self.manifest]:
            with self.subTest(files=len(manifest['files'])):
                self.assertIs(validate_manifest(manifest, component='execution'), manifest)
                dependencies = copy.deepcopy(manifest)
                dependencies['files'].append(dict(path='payload/node_modules/dependency/index.js', bytes=0, sha256='b'*64))
                validate_manifest(dependencies, component='execution')
                # Adding or removing a non-entry file is the module's own decision; no body swap.
                for change in [lambda m: m['files'].append(dict(path='payload/src/aiterm-operation-lease.mjs', bytes=0, sha256='b'*64)),
                    lambda m: m.update(files=[r for r in m['files'] if r['path'] != 'payload/src/module-ipc.mjs'])]:
                    accepted = copy.deepcopy(manifest); change(accepted)
                    self.assertIs(validate_manifest(accepted, component='execution'), accepted)
                for change in [lambda m: m.update(files=[r for r in m['files'] if r['path'] != m['entry']]),
                    lambda m: m['runtime'].update(nodeMajor=24)]:
                    invalid = copy.deepcopy(manifest); change(invalid)
                    with self.assertRaises(ValueError): validate_manifest(invalid, component='execution')

    def test_producer_requires_current_50_layout(self):
        for missing in ['aiterm-hooks.mjs', 'model-handoff.mjs', 'automatic-configuration-application.mjs']:
            path = self.root / 'payload/src' / missing
            raw = path.read_bytes(); path.unlink()
            output = self.root / ('missing-' + missing + '.tar.gz')
            try:
                with self.subTest(missing=missing), self.assertRaises(ValueError):
                    write_archive(self.root / 'payload', output, 'a'*40, self.arch, component='execution')
                self.assertFalse(output.exists())
            finally:
                path.write_bytes(raw)

    def test_fixed_source_relative_import_closure(self):
        root = Path(__file__).resolve().parents[1]
        files = sorted(name.removeprefix('payload/') for name in EXECUTION_FILES)
        script = """
import { SourceTextModule } from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
const files = JSON.parse(readFileSync(0, 'utf8')), selected = new Set(files), missing = [];
for (const file of files.filter(name => name.endsWith('.mjs'))) {
  const module = new SourceTextModule(readFileSync(resolve(process.argv[1], file), 'utf8'));
  for (const specifier of module.dependencySpecifiers.filter(name => name.startsWith('.'))) {
    const target = posix.normalize(posix.join(dirname(file), specifier));
    if (!selected.has(target)) missing.push({ from: file, target });
  }
}
process.stdout.write(JSON.stringify(missing));
"""
        missing = json.loads(subprocess.check_output(['node', '--experimental-vm-modules',
            '--input-type=module', '-e', script, str(root)], input=json.dumps(files), text=True))
        self.assertEqual(missing, [])

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

    def test_installer_fixed_execution_receipt_and_literal_bytes(self):
        path=Path(__file__).resolve().parents[1]/'scripts/install-web-gateway-release.py'
        spec=importlib.util.spec_from_file_location('installer',path)
        installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
        with self.archive.open('rb') as stream: manifest,digest=check_archive(stream,component='execution')
        expected=dict(archiveSha256=hashlib.sha256(self.archive.read_bytes()).hexdigest(),sourceCommit='a'*40,signerCommit='a'*40)
        receipt=dict(schema='bellteam.execution.verification.v1',archiveSha256=expected['archiveSha256'],manifestSha256=digest,
            manifest=manifest,verification=dict(method='github-oidc-attestation',repositoryId='1404510084'))
        target=self.root/'installed';target.mkdir()
        wrong=copy.deepcopy(receipt);wrong['manifest']['component']='members'
        with self.assertRaises(ValueError): installer.extract(self.archive,wrong,expected,target,'execution')
        self.assertEqual(list(target.iterdir()),[])
        try:
            installer.extract(self.archive,receipt,expected,target,'execution')
            self.assertEqual(json.loads((target/'installation.json').read_text())['component'],'execution')
            self.assertEqual(target.stat().st_mode&4095,0o555)
            for row in manifest['files']:
                file=target/row['path'];self.assertEqual(file.stat().st_mode&4095,0o444)
                self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(),row['sha256'])
        finally:
            for directory in [target,*target.rglob('*')]:
                if directory.is_dir(): directory.chmod(0o700)


if __name__=='__main__': unittest.main()
