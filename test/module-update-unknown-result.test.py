import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('unknown_module_service', Path(__file__).parents[1] / 'scripts/module-update-service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)
host = service.host


class UnknownResultTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).parents[1])
        self.addCleanup(temporary.cleanup)
        prefix = Path(temporary.name)
        (prefix / 'state').mkdir(mode=0o700)
        current = {'sourceCommit': 'a' * 40, 'platform': {'os': 'linux', 'arch': 'amd64'},
                   'privateVolume': {'device': '1', 'inode': '2'}}
        self.calls = 0

        def execute(*_args):
            self.calls += 1
            raise RuntimeError('private body and credentials must not become a receipt')

        self.updater = service.ModuleUpdater(prefix, prefix, {'release': 'a' * 40, 'platform': current['platform']},
            uid=os.getuid(), inspect=lambda: current, execute=execute)
        self.updater.assert_model_binding = lambda *_args: None
        self.updater.module_volume = lambda *_args: current['privateVolume']
        target = {'componentId': 'execution', 'versionId': 'b' * 64}
        self.updater.planned_target = lambda _plan: target
        plan_id, request_id = str(uuid.uuid4()), str(uuid.uuid4())
        host.atomic(self.updater.state / 'plans' / (plan_id + '.json'), dict(planId=plan_id, target=target,
            expected=current, expiresAt='2099-01-01T00:00:00+00:00', impact={'containerRestart': False}))
        self.updater.launcher = self.updater.worker
        self.params = dict(requestId=request_id, planId=plan_id, confirmContainerRestart=False)
        self.initial = self.updater.start(self.params)
        self.path = self.updater.state / 'operations' / request_id / 'operation.json'
        self.updater.worker_alive = Mock(return_value=False)

    def test_execution_unknown_remains_byte_exact_after_worker_exit_and_still_blocks_new_execution(self):
        self.assertEqual(self.initial['admission'], 'accepted')
        self.assertEqual(self.initial['phase'], 'unknown')
        self.assertEqual(self.initial['error'], 'HOST_UPDATE_EXECUTION_UNKNOWN')
        original, mtime = self.path.read_bytes(), self.path.stat().st_mtime_ns
        for _ in range(2):
            observed = self.updater.get(self.params['requestId'])
            self.assertEqual(observed, self.initial)
            self.assertEqual(self.path.read_bytes(), original)
            self.assertEqual(self.path.stat().st_mtime_ns, mtime)
        self.updater.worker_alive.assert_not_called()
        self.assertEqual(self.updater.start(self.params), self.initial)
        with self.assertRaises(host.Failure) as refused:
            self.updater.start({**self.params, 'requestId': str(uuid.uuid4())})
        self.assertEqual(refused.exception.code, 'HOST_UPDATE_IN_PROGRESS')
        self.assertEqual(self.calls, 1)
        self.assertNotIn(b'credentials', original)

    def test_applying_worker_loss_is_recorded_once_without_changing_later_gets(self):
        value = self.updater.read_operation(self.params['requestId'])
        value.update(phase='applying', execution='pending', verification='pending', error=None)
        host.atomic(self.path, value)
        first = self.updater.get(self.params['requestId'])
        self.assertEqual(first['phase'], 'unknown')
        self.assertEqual(first['error'], 'HOST_UPDATE_WORKER_LOST')
        original, mtime = self.path.read_bytes(), self.path.stat().st_mtime_ns
        self.assertEqual(self.updater.get(self.params['requestId']), first)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(self.path.stat().st_mtime_ns, mtime)
        self.assertEqual(self.updater.worker_alive.call_count, 1)
        self.assertEqual(self.calls, 1)


if __name__ == '__main__':
    unittest.main()
