"""Input rejection only; Docker/root/crypto tests run on the dedicated native workflow."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('members_fixture', ROOT / 'test/helpers/members-real-boundary.py')
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)


class MembersBoundaryInputs(unittest.TestCase):
    def test_invalid_source_run_or_digest_never_reads_api(self):
        valid = ['a' * 40, 1, 2, 'sha256:' + 'b' * 64]
        for index, bad in [(0, 'main'), (0, 'a' * 39), (1, 0), (1, 2), (2, True), (3, 'latest'), (3, 'sha256:' + 'b' * 63)]:
            values = valid.copy(); values[index] = bad
            with self.subTest(index=index, bad=bad), tempfile.TemporaryDirectory() as directory, patch.object(fixture, 'api') as api:
                with self.assertRaises(AssertionError):
                    fixture.fetch_inputs(*values, Path(directory) / 'output')
                api.assert_not_called()
                self.assertFalse((Path(directory) / 'output').exists())

    def test_author_saved_documents_and_current_state_sources_are_exact(self):
        root = ROOT / 'test/fixtures/members-saved-state'
        manifest = json.loads((root / 'manifest.json').read_text())
        for item in manifest['documents']:
            raw = (root / item['path']).read_bytes()
            self.assertEqual(len(raw), item['bytes'])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item['sha256'])
        for item in manifest['sources']:
            raw = (ROOT / item['path']).read_bytes()
            self.assertEqual(len(raw), item['bytes'])
            self.assertEqual(hashlib.sha256(raw).hexdigest(), item['sha256'])
        schedule = json.loads((root / 'root/state/bots/bot-fixture/schedule.json').read_text())
        self.assertNotIn('.deleting', [p.name for p in (root / 'root/state/bots').iterdir()])
        self.assertEqual(manifest['checks']['enabledSchedules'], 0)
        self.assertEqual(manifest['optionalReceipt']['notPartOfBase'], True)

    def test_arbitrary_repository_never_invokes_docker(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(fixture, 'execute') as execute:
            with self.assertRaises(AssertionError):
                fixture.run_fixture('evil.example/image:latest', Path(directory) / 'out', Path(directory) / 'supply')
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
