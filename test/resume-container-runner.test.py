import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/verify-resume-runtime.py'


class RunnerFailureTest(unittest.TestCase):
    def test_mutable_image_is_rejected_before_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'result'
            result = subprocess.run(['python3', str(SCRIPT), 'latest', str(output)], capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(output.exists())

    def test_failed_inspection_keeps_failure_and_only_cleans_its_namespace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / 'docker'
            log = root / 'commands.jsonl'
            docker.write_text('''#!/usr/bin/env python3
import json,os,sys
with open(os.environ['H1_COMMAND_LOG'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
if sys.argv[1:3]==['image','inspect']:sys.exit(1)
''')
            docker.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       TMPDIR=directory, H1_COMMAND_LOG=str(log))
            output = root / 'artifact'
            result = subprocess.run(['python3', str(SCRIPT), 'sha256:' + 'a' * 64, str(output)],
                                    env=env, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 1, result.stderr)
            report = json.loads((output / 'result.json').read_text())
            self.assertFalse(report['accepted'])
            self.assertEqual(report['failure']['stage'], 'image-binding')
            commands = [json.loads(line) for line in log.read_text().splitlines()]
            self.assertFalse(any('prune' in command for command in commands))
            removed = [command[-1] for command in commands if command[:2] == ['volume', 'rm']]
            self.assertEqual(removed, [report['prefix'] + '-' + suffix for suffix in ['old', 'new', 'private']])
            self.assertFalse(list(root.glob(report['prefix'] + '-*')))


if __name__ == '__main__':
    unittest.main()
