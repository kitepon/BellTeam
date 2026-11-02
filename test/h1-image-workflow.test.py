import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

WORKFLOW = Path(__file__).resolve().parents[1] / '.github/workflows/verify-h1-runtime-image.yml'
STEPS = json.loads(WORKFLOW.read_text())['jobs']['runtime']['steps']
CLEANUP = STEPS[3]['run'].split("python3 - <<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]


class WorkflowCleanupTest(unittest.TestCase):
    def test_cancel_cleanup_removes_only_allocated_namespace(self):
        with tempfile.TemporaryDirectory() as directory:
            prefix = 'h1-runtime-' + 'a' * 12
            volumes = [prefix + '-' + suffix for suffix in ['old', 'new', 'private']]
            allocation = dict(prefix=prefix, volumes=volumes, containerLabel='bellteam.h1-fixture=' + prefix, composeProject=prefix)
            Path(directory, 'allocation.json').write_text(json.dumps(allocation))
            remaining_containers, remaining_volumes, commands = {'b' * 12}, set(volumes), []
            def docker(command, **kwargs):
                commands.append(command)
                if command[1:3] == ['ps', '-aq']:
                    return '\n'.join(remaining_containers)
                if command[1:3] == ['volume', 'ls']:
                    return '\n'.join(sorted(remaining_volumes))
                if command[1:3] == ['rm', '-f']:
                    remaining_containers.remove(command[-1]); return ''
                if command[1:3] == ['volume', 'rm']:
                    remaining_volumes.remove(command[-1]); return ''
                raise AssertionError(command)
            with patch.dict(os.environ, RESULT_DIR=directory), patch('subprocess.check_output', side_effect=docker):
                exec(compile(CLEANUP, str(WORKFLOW), 'exec'), {})
            self.assertFalse(remaining_containers or remaining_volumes)
            self.assertTrue(Path(directory, 'workflow-cleanup.json').exists())
            self.assertFalse(any('prune' in command for command in commands))
            self.assertEqual({c[-1] for c in commands if c[1:3] == ['volume', 'rm']}, set(volumes))

    def test_tampered_allocation_is_rejected_before_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            prefix = 'h1-runtime-' + 'a' * 12
            Path(directory, 'allocation.json').write_text(json.dumps(dict(prefix=prefix, containerLabel='bellteam.h1-fixture=' + prefix, composeProject=prefix, volumes=['production'])))
            with patch.dict(os.environ, RESULT_DIR=directory), patch('subprocess.check_output') as docker:
                with self.assertRaises(AssertionError):
                    exec(compile(CLEANUP, str(WORKFLOW), 'exec'), {})
                docker.assert_not_called()

    def test_mutable_digest_fails_before_pull(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory, 'called')
            executable = Path(directory, 'docker')
            executable.write_text('#!/bin/sh\ntouch "$H1_DOCKER_LOG"\n')
            executable.chmod(0o755)
            env = dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'], H1_DOCKER_LOG=str(log), EXPECTED_DIGEST='latest', EXPECTED_SOURCE='a' * 40, ARCH='amd64')
            result = subprocess.run(['bash', '-e', '-c', STEPS[1]['run']], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(log.exists())


if __name__ == '__main__':
    unittest.main()
