import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('m_native_input', ROOT / 'scripts/prepare-m-native-image.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class NativeInputs(unittest.TestCase):
    def setUp(self):
        self.value = json.loads((ROOT / 'config/m-native-image-input.json').read_text())
        self.value.update(ready=True, releaseId=1, cliVersion='0.166.0', cliPackageVersion='0.166.0-bellteam.test')
        self.value['cli'] = dict(id=2, bytes=3, sha256='a' * 64)
        self.value['aiterm']['id'] = 3

    def archive(self, change=lambda members: None):
        metadata = dict(layoutVersion=1, version=self.value['cliPackageVersion'], target='x86_64-unknown-linux-gnu', variant='codex',
                        entrypoint='bin/codex', execServer='bin/codex-exec-server', resourcesDir='codex-resources', pathDir='codex-path')
        members = [(name, json.dumps(metadata).encode() if name.endswith('.json') else b'fixture') for name in sorted(m.CLI_FILES)]
        change(members)
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w') as archive:
            for name, data in members:
                member = tarfile.TarInfo(name)
                if data is None:
                    member.type = tarfile.SYMTYPE
                    member.linkname = '/etc/passwd'
                else:
                    member.size = len(data)
                archive.addfile(member, io.BytesIO(data) if data is not None else None)
        output.seek(0)
        return tarfile.open(fileobj=output)

    def test_unready_checked_in_input_never_calls_api(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(m, 'api') as api:
            with self.assertRaisesRegex(ValueError, 'M_INPUT_NOT_READY'):
                m.fetch(ROOT / 'config/m-native-image-input.json', Path(temp) / 'not-created')
            api.assert_not_called()
            self.assertFalse((Path(temp) / 'not-created').exists())

    def test_source_alias_and_extra_field_cannot_expand_inputs(self):
        self.assertIs(m.manifest(self.value), self.value)
        for change in [lambda v: v.update(nativeSource='b' * 40), lambda v: v['aiterm'].update(id=2),
                       lambda v: v['cli'].update(id=True), lambda v: v['cli'].update(url='https://example.com'),
                       lambda v: v['aiterm'].update(sha256='b' * 64)]:
            value = copy.deepcopy(self.value)
            change(value)
            with self.assertRaises(ValueError):
                m.manifest(value)

    def test_public_release_or_changed_asset_rejected(self):
        release = dict(id=1, draft=True, assets=[dict(id=row['id'], size=row['bytes'], digest='sha256:' + row['sha256'], state='uploaded') for row in [self.value['cli'], self.value['aiterm']]])
        m.release_identity(release, self.value)
        for change in [lambda r: r.update(draft=False), lambda r: r['assets'][0].update(size=1), lambda r: r['assets'][0].update(digest='sha256:' + '0' * 64)]:
            changed = copy.deepcopy(release)
            change(changed)
            with self.assertRaises(ValueError):
                m.release_identity(changed, self.value)

    def test_exact_cli_package_and_separate_reported_version(self):
        with self.archive() as archive:
            self.assertEqual(len(m.cli_inventory(archive, self.value['cliPackageVersion'])), 6)
            with self.assertRaisesRegex(ValueError, 'M_CLI_PACKAGE_IDENTITY'):
                m.cli_inventory(archive, self.value['cliVersion'])

    def test_traversal_link_duplicate_extra_and_missing_rejected(self):
        for change in [lambda rows: rows.append(('../outside', b'x')), lambda rows: rows.append(('/outside', b'x')),
                       lambda rows: rows.append(('unexpected', b'x')), lambda rows: rows.append(rows[0]),
                       lambda rows: rows.__setitem__(0, ('bin/codex', None)), lambda rows: rows.pop()]:
            with self.archive(change) as archive, self.assertRaises(ValueError):
                m.cli_inventory(archive, self.value['cliPackageVersion'])

    def test_digest_failure_and_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'asset'
            path.write_bytes(b'abc')
            expected = dict(bytes=3, sha256=hashlib.sha256(b'abc').hexdigest())
            m.check_file(path, expected)
            path.write_bytes(b'abd')
            with self.assertRaisesRegex(ValueError, 'M_INPUT_DIGEST'):
                m.check_file(path, expected)
            link = Path(temp) / 'link'
            link.symlink_to(path)
            with self.assertRaisesRegex(ValueError, 'M_INPUT_SIZE'):
                m.check_file(link, expected)

    def test_http_denial_has_closed_receipt_no_retry_or_raw_output(self):
        for code in [403, 404]:
            result = subprocess.CompletedProcess([], 1, stdout=b'ignored', stderr=f'gh: denied (HTTP {code})'.encode())
            with patch.object(m.subprocess, 'run', return_value=result) as run:
                with self.assertRaises(RuntimeError) as error:
                    m.api('releases/assets/2')
                self.assertEqual(json.loads(str(error.exception))['httpStatus'], code)
                run.assert_called_once()
                self.assertEqual(run.call_args.args[0], ['gh', 'api', 'repos/kitepon/BellTeam/releases/assets/2'])


if __name__ == '__main__':
    unittest.main()
