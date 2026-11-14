#!/usr/bin/env python3
"""Focused clean-prefix packer fixture; no npm, network, Docker or host access."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import runtime_update as runtime

spec = importlib.util.spec_from_file_location('package_runtime', ROOT / 'scripts/package-runtime.py')
packer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packer)

SOURCE = 'a' * 40
PLATFORM = {'os': 'linux', 'arch': 'amd64', 'libc': 'glibc', 'nodeMajor': 26}


class RuntimeArtifact(unittest.TestCase):
    def test_throughline_probe_binds_stdin_and_disposable_state(self):
        first = {'schema': 'throughline.observer_check_result.v1', 'status': 'complete',
                 'results': [{'id': 'runtime-package', 'status': 'changed', 'token': 'tloc1.fixture'}]}
        second = {**first, 'results': [{**first['results'][0], 'status': 'unchanged'}]}
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            binary = root / 'prefix/bin/throughline'
            calls = []

            tl = root / 'throughline-probe/tl'
            located = {'schema': 'throughline.storage_locations.v1', 'source': 'THROUGHLINE_HOME', 'database': str(tl / 'throughline.db'),
                       'roots': {'data': str(tl), 'appState': str(tl / 'app-state'), 'appConfig': str(tl / 'app-config')}}

            def fake_run(args, *, env, cwd, input=None, timeout=120):
                calls.append({'args': args, 'env': dict(env), 'cwd': Path(cwd), 'input': input, 'timeout': timeout})
                output = '0.19.0\n' if len(calls) == 1 else json.dumps([first, second, located][len(calls) - 2])
                return SimpleNamespace(stdout=output, stderr='')

            with patch.object(packer, 'run', side_effect=fake_run):
                result = packer.probe_throughline(binary, root, {'PATH': '/usr/bin'})
            project = root / 'throughline-probe/project'
            self.assertEqual(result, {'version': '0.19.0', 'firstStatus': 'changed',
                                      'secondStatus': 'unchanged', 'databaseCreated': False})
            self.assertEqual(calls[0]['args'], [str(binary), '--version'])
            self.assertEqual(calls[0]['cwd'], project)
            self.assertEqual([call['args'] for call in calls[1:]],
                             [[str(binary), 'observer-check', '--json']] * 2 + [[str(binary), 'storage', 'locate', '--json']])
            requests = [json.loads(call['input']) for call in calls[1:3]]
            self.assertEqual([request['schema'] for request in requests],
                             ['throughline.observer_check_request.v1'] * 2)
            self.assertEqual([request['projects'][0] for request in requests],
                             [{'id': 'runtime-package', 'projectPath': str(project), 'after': None},
                              {'id': 'runtime-package', 'projectPath': str(project), 'after': 'tloc1.fixture'}])
            for call in calls:
                self.assertEqual(call['cwd'], project)
                self.assertEqual(call['env']['HOME'], str(root / 'throughline-probe'))
                self.assertEqual(call['env']['USERPROFILE'], str(root / 'throughline-probe'))
                self.assertEqual(call['env']['CODEX_HOME'], str(root / 'throughline-probe/codex'))
                self.assertEqual(call['env']['XDG_STATE_HOME'], str(root / 'throughline-probe/state'))
                self.assertEqual(call['env']['LOCALAPPDATA'], str(root / 'throughline-probe/state'))
                self.assertEqual(call['env']['THROUGHLINE_HOME'], str(tl))
            bad_second = {**first, 'results': [{**first['results'][0], 'status': 'changed'}]}
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            outputs = iter(['0.19.0\n', json.dumps(first), json.dumps(bad_second)])
            with patch.object(packer, 'run', side_effect=lambda *a, **k: SimpleNamespace(stdout=next(outputs), stderr='')):
                with self.assertRaisesRegex(ValueError, 'second observer-check was not unchanged'):
                    packer.probe_throughline(root / 'prefix/bin/throughline', root, {'PATH': '/usr/bin'})
        for version, created in (('0.18.9\n', False), ('0.20.1\n', True)):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as scratch:
                root = Path(scratch)
                tl = root / 'throughline-probe/tl'
                if created:
                    (tl / 'app-state').mkdir(parents=True)
                located = {'schema': 'throughline.storage_locations.v1', 'source': 'THROUGHLINE_HOME',
                           'roots': {'data': str(tl), 'appState': str(tl / 'app-state'), 'appConfig': str(tl / 'app-config')}}
                outputs = iter([version, json.dumps(first), json.dumps(second), json.dumps(located)])
                with patch.object(packer, 'run', side_effect=lambda *a, **k: SimpleNamespace(stdout=next(outputs), stderr='')):
                    with self.assertRaisesRegex(ValueError, 'created a database/state path' if created else '0.19.0 or newer'):
                        packer.probe_throughline(root / 'prefix/bin/throughline', root, {'PATH': '/usr/bin'})

    def test_manifest_first_modes_symlink_and_real_extract_contract(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            prefix = root / 'prefix'
            binary = prefix / 'lib/node_modules/@openai/codex/bin/codex.js'
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'#!/usr/bin/env node\nconsole.log("fixture")\n')
            binary.chmod(0o755)
            (prefix / 'bin').mkdir()
            os.symlink('../lib/node_modules/@openai/codex/bin/codex.js', prefix / 'bin/codex')
            manifest = {'schema': runtime.ARTIFACT_SCHEMA, 'component': 'runtime-codex',
                        'package': runtime.COMPONENTS['runtime-codex']['package'], 'upstreamVersion': '1.2.3',
                        'sourceCommit': SOURCE, 'platform': PLATFORM, 'files': packer.inspect_prefix(prefix)}
            runtime.validate_manifest(manifest, 'runtime-codex', {'sourceCommit': SOURCE}, PLATFORM)
            archive = root / 'fixture.tar.gz'
            raw = packer.write_archive(prefix, manifest, archive)
            with tarfile.open(archive, 'r:gz') as tar:
                self.assertEqual(tar.next().name, 'manifest.json')
                members = {member.name: member for member in tar}
            self.assertEqual(members['prefix/lib/node_modules/@openai/codex/bin/codex.js'].mode, 0o555)
            self.assertEqual(members['prefix/bin/codex'].linkname, '../lib/node_modules/@openai/codex/bin/codex.js')
            receipt = {'component': 'runtime-codex', 'manifest': manifest,
                       'manifestSha256': hashlib.sha256(raw).hexdigest()}
            destination = root / 'unpacked'
            destination.mkdir()
            runtime.extract(archive, receipt, {'sourceCommit': SOURCE}, destination, PLATFORM)
            extracted = destination / 'prefix'
            self.assertEqual(os.readlink(extracted / 'bin/codex'), '../lib/node_modules/@openai/codex/bin/codex.js')
            self.assertEqual((extracted / 'lib/node_modules/@openai/codex/bin/codex.js').read_bytes(), binary.read_bytes())
            self.assertEqual((extracted / 'lib/node_modules/@openai/codex/bin/codex.js').stat().st_mode & 0o777, 0o555)
            self.assertEqual((destination / 'manifest.json').read_bytes(), raw)

    def test_prefix_escape_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as scratch:
            prefix = Path(scratch) / 'prefix'
            prefix.mkdir()
            (prefix / 'bin').mkdir()
            os.symlink('../../../etc/passwd', prefix / 'bin/codex')
            with self.assertRaisesRegex(ValueError, 'escaping symlink'):
                packer.inspect_prefix(prefix)


if __name__ == '__main__':
    unittest.main()
