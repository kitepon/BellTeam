"""Input rejection only; Docker/root/crypto tests run on the dedicated native workflow."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('diagnostics_fixture', ROOT / 'test/helpers/diagnostics-real-boundary.py')
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)


class DiagnosticsBoundaryInputs(unittest.TestCase):
    def test_invalid_source_run_or_digest_never_reads_api(self):
        valid = ['a' * 40, 1, 2, 'sha256:' + 'b' * 64]
        for index, bad in [(0, 'main'), (0, 'a' * 39), (1, 0), (1, 2), (2, True), (3, 'latest'), (3, 'sha256:' + 'b' * 63)]:
            values = valid.copy(); values[index] = bad
            with self.subTest(index=index, bad=bad), tempfile.TemporaryDirectory() as directory, patch.object(fixture, 'api') as api:
                with self.assertRaises(AssertionError):
                    fixture.fetch_inputs(*values, Path(directory) / 'output')
                api.assert_not_called()
                self.assertFalse((Path(directory) / 'output').exists())

    def test_wrong_source_run_cannot_supply_archive(self):
        wrong = dict(head_sha='c' * 40, run_attempt=1, conclusion='success')
        with tempfile.TemporaryDirectory() as directory, patch.object(fixture, 'api', return_value=json.dumps(wrong)), patch.object(fixture, 'extract_artifact') as extract:
            with self.assertRaises(AssertionError):
                fixture.fetch_inputs('a' * 40, 1, 2, 'sha256:' + 'b' * 64, Path(directory) / 'out')
            extract.assert_not_called()

    def test_wrong_workflow_repository_or_attempt_rejects_before_archive(self):
        valid = dict(head_sha='a' * 40, run_attempt=1, conclusion='success',
                     repository={'id': 1404510084}, path='.github/workflows/publish-diagnostics.yml', event='workflow_dispatch')
        for bad in [{'run_attempt': 2}, {'repository': {'id': 1}},
                    {'path': '.github/workflows/publish-usage.yml'}, {'event': 'push'}]:
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as directory, \
                    patch.object(fixture, 'api', return_value=json.dumps({**valid, **bad})), \
                    patch.object(fixture, 'extract_artifact') as extract:
                with self.assertRaises(AssertionError):
                    fixture.fetch_inputs('a' * 40, 1, 2, 'sha256:' + 'b' * 64, Path(directory) / 'out')
                extract.assert_not_called()

    def test_arbitrary_repository_never_invokes_docker(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(fixture, 'execute') as execute:
            with self.assertRaises(AssertionError):
                fixture.run_fixture('evil.example/image:latest', Path(directory) / 'out', Path(directory) / 'supply')
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
