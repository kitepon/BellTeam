"""Input rejection only; Docker/root/crypto tests run on the dedicated native workflow."""
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('memory_fixture', ROOT / 'test/helpers/memory-real-boundary.py')
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)


class MemoryBoundaryInputs(unittest.TestCase):
    def test_transient_get_retry_is_bounded_and_returns_only_success_bytes(self):
        transient = subprocess.CompletedProcess([], 1, b'partial', b'gh: HTTP 503\n')
        success = subprocess.CompletedProcess([], 0, b'complete', b'')
        with patch.object(fixture.shared, 'execute', side_effect=[transient, success]) as execute, patch.object(fixture.shared.time, 'sleep') as sleep:
            self.assertEqual(fixture.shared.api('actions/artifacts/1/zip'), b'complete')
            self.assertEqual(execute.call_count, 2)
            sleep.assert_called_once_with(1)
            self.assertTrue(all(call.args[0] == ['gh', 'api', 'repos/kitepon/BellTeam/actions/artifacts/1/zip'] for call in execute.call_args_list))
        with patch.object(fixture.shared, 'execute', return_value=transient) as execute, patch.object(fixture.shared.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'HTTP 503'):
                fixture.shared.api('actions/artifacts/1/zip')
            self.assertEqual(execute.call_count, 3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])

    def test_get_auth_or_other_failure_is_not_retried(self):
        for error in [b'gh: HTTP 401', b'gh: HTTP 403', b'gh: HTTP 404', b'connection reset']:
            with self.subTest(error=error), patch.object(fixture.shared, 'execute', return_value=subprocess.CompletedProcess([], 1, b'', error)) as execute, patch.object(fixture.shared.time, 'sleep') as sleep:
                with self.assertRaises(RuntimeError): fixture.shared.api('actions/artifacts/1/zip')
                execute.assert_called_once(); sleep.assert_not_called()

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

    def test_arbitrary_repository_never_invokes_docker(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(fixture, 'execute') as execute:
            with self.assertRaises(AssertionError):
                fixture.run_fixture('evil.example/image:latest', Path(directory) / 'out', Path(directory) / 'supply')
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
