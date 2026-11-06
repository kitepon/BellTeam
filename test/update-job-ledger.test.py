import importlib.util
import os
import socket
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('job_host', Path(__file__).resolve().parents[1] / 'scripts/container-update-host.py')
host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)

class DurableJobs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]); self.addCleanup(self.temp.cleanup)
        self.prefix = Path(self.temp.name); (self.prefix / 'state').mkdir(mode=0o700)
        self.current = {'sourceCommit': 'a' * 40}
        self.updater = host.HostUpdater(self.prefix, {}, uid=os.getuid(), inspect=lambda: self.current, launcher=self.launch, execute=self.execute)
        self.updater.assert_model_binding = lambda *_: None
        self.updater.module_volume = lambda *_: {}
        self.threads = []; self.launches = []; self.ready_to_finish = threading.Event(); self.ready_to_finish.set()
        self.addCleanup(self.finish)
    def finish(self):
        self.ready_to_finish.set()
        for thread in self.threads:
            thread.join(2); self.assertFalse(thread.is_alive())
    def plan(self, component='container'):
        identifier = str(uuid.uuid4())
        plan = {'planId': identifier, 'catalogSha256': 'b' * 64,
                'target': {'componentId': component, 'versionId': 'c' * 64}, 'expected': self.current,
                'impact': {'containerRestart': component == 'container'}, 'expiresAt': '2099-01-01T00:00:00+00:00'}
        self.updater.planned_target = lambda item: item['target']
        host.atomic(self.updater.state / 'plans' / (identifier + '.json'), plan)
        return plan
    def launch(self, identifier):
        # The real file is readable before launcher invocation, including after a fresh reader is constructed.
        job = self.updater.read_job(identifier); self.assertEqual(job['state'], 'queued')
        self.launches.append(identifier)
        thread = threading.Thread(target=self.updater.worker, args=(identifier,)); self.threads.append(thread); thread.start()
    def execute(self, plan, directory):
        self.updater.progress(directory, 'verifying')
        self.ready_to_finish.wait(2)
        if plan['target']['componentId'] == 'container': self.updater.progress(directory, 'swapping')
        return dict(execution='succeeded', verification='succeeded', cleanup='succeeded', rollback='not_needed', observed=None, error=None)
    def admission(self, component='usage', version='builtin'):
        return dict(jobId=str(uuid.uuid4()), idempotencyKey=str(uuid.uuid4()), kind='module',
                    target=dict(catalogSha256=None, moduleId=component, versionId=version))
    def test_durable_start_dedup_and_terminal_read(self):
        plan = self.plan(); identifier = str(uuid.uuid4())
        args = dict(requestId=identifier, planId=plan['planId'], confirmContainerRestart=True, idempotencyKey='same-key')
        syncs = []
        actual = os.fsync
        def fsync(fd): syncs.append(fd); return actual(fd)
        with patch.object(host.os, 'fsync', side_effect=fsync): self.updater.start(args)
        self.finish()
        value = self.updater.start({**args, 'requestId': str(uuid.uuid4())})
        self.assertEqual(value['jobId'], identifier); self.assertEqual(self.launches, [identifier]); self.assertGreater(len(syncs), 2)
        self.assertEqual(value['state'], 'ready'); self.assertIsNone(value['reason'])
        self.assertEqual([t['state'] for t in value['job']['transitions']], host.JOB_STATES[:-1])
        self.assertIsInstance(value['job']['updatedAtNs'], str)
    def test_builtin_admission_module_install_and_probe_result_are_distinct(self):
        params = self.admission(); job = self.updater.admit_job(params)
        self.assertEqual(self.updater.admit_job({**params, 'jobId': str(uuid.uuid4())})['jobId'], job['jobId'])
        self.assertEqual(self.launches, [])
        for state in ['downloading', 'verifying', 'swapping']:
            self.updater.update_job(dict(jobId=job['jobId'], state=state, reason=None))
        reason = dict(code='READY_PROBE_FAILED', message='READY_PROBE_FAILED')
        self.updater.update_job(dict(jobId=job['jobId'], state='failed', reason=reason))
        self.assertEqual(self.updater.job(job['jobId'])['reason'], reason)
        plan = self.plan('usage'); params = self.admission(version='c' * 64); params['target']['catalogSha256'] = plan['catalogSha256']
        self.updater.admit_job(params)
        # Pre-admission can precede installer start by more than the handoff deadline.
        job=self.updater.read_job(params['jobId']);old=str(int(job['updatedAtNs'])-120_000_000_000)
        job['updatedAtNs']=old;job['transitions'][0]['atNs']=old
        host.atomic(self.updater.state/'jobs'/(job['jobId']+'.json'),job)
        self.updater.start(dict(requestId=params['jobId'], idempotencyKey=params['idempotencyKey'], planId=plan['planId'], confirmContainerRestart=False))
        self.finish(); job = self.updater.job(params['jobId'])
        self.assertEqual(job['state'], 'verifying')
        with self.assertRaises(host.Failure): self.updater.update_job(dict(jobId=job['jobId'], state='ready', reason=None))
        self.updater.update_job(dict(jobId=job['jobId'], state='swapping', reason=None))
        self.updater.update_job(dict(jobId=job['jobId'], state='ready', reason=None))
        self.assertEqual(self.updater.jobs()['jobs'][0]['state'], 'ready')
    def test_failure_unreadable_and_count_retention(self):
        plan = self.plan(); self.updater.launcher = lambda _: (_ for _ in ()).throw(OSError())
        args = dict(requestId=str(uuid.uuid4()), planId=plan['planId'], confirmContainerRestart=True)
        result = self.updater.start(args)
        self.assertEqual(result['state'], 'failed'); self.assertEqual(result['reason']['code'], 'HOST_UPDATE_HANDOFF_FAILED')
        active = self.updater.admit_job(self.admission())
        with patch.object(host, 'JOB_RETAIN', 2):
            for _ in range(4):
                job = self.updater.admit_job(self.admission())
                self.updater.update_job(dict(jobId=job['jobId'], state='failed', reason=dict(code='TEST_FAILED', message='TEST_FAILED')))
        self.assertEqual(len(list((self.updater.state / 'jobs').glob('*.json'))), 3)
        path = self.updater.state / 'jobs' / (active['jobId'] + '.json'); path.write_text('{')
        with self.assertRaises(host.Failure) as caught: self.updater.job(active['jobId'])
        self.assertEqual(caught.exception.code, 'UNREADABLE'); self.assertEqual(caught.exception.path, str(path))

    def test_http_get_job_uses_the_same_record_and_peer_contract(self):
        job=self.updater.admit_job(self.admission())
        path=str(self.prefix/'socket')
        server=host.Server(path,self.updater)
        worker=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01});worker.start()
        try:
            # Fixture substitutes only peer UID; production still requires1001.
            with patch.object(host.struct,'unpack',return_value=(os.getpid(),1001,os.getgid())):
                for route in ['/jobs/'+job['jobId'],'/jobs']:
                    with socket.socket(socket.AF_UNIX) as client:
                        client.settimeout(2);client.connect(path);client.sendall(('GET '+route+' HTTP/1.1\r\nHost: localhost\r\n\r\n').encode())
                        chunks=[]
                        while block:=client.recv(65536):chunks.append(block)
                    header,body=b''.join(chunks).split(b'\r\n\r\n',1)
                    self.assertIn(b'200',header);value=json.loads(body)
                    self.assertEqual(value if route!='/jobs' else value['jobs'][0],job)
        finally:
            server.shutdown();worker.join(2);server.server_close()

    def test_parent_abort_only_closes_unclaimed_queued_container(self):
        def admit():
            params = self.admission(component='container', version='sha256:' + 'd' * 64)
            params['kind'] = 'container'
            return self.updater.admit_job(params)
        job = admit()
        reason = dict(code='EARLIER_MODULE_FAILED', message='EARLIER_MODULE_FAILED')
        params = dict(jobId=job['jobId'], state='failed', reason=reason)
        for state in ['downloading', 'verifying', 'swapping', 'ready']:
            with self.assertRaises(host.Failure) as error:
                self.updater.update_job(dict(params, state=state, reason=None))
            self.assertEqual(error.exception.code, 'HOST_UPDATE_JOB_CONFLICT')
        saved = self.updater.dispatch(dict(operation='updateJob', params=params))
        self.assertEqual(saved['state'], 'failed'); self.assertEqual(saved['reason'], reason)
        self.assertEqual([row['state'] for row in saved['transitions']], ['queued', 'failed'])
        self.assertEqual(self.updater.job(job['jobId']), saved)
        self.assertFalse((self.updater.state / 'operations' / job['jobId']).exists())
        with self.assertRaises(host.Failure):
            self.updater.start(dict(requestId=job['jobId'], idempotencyKey=job['idempotencyKey'],
                                    planId=str(uuid.uuid4()), confirmContainerRestart=True))
        for marker in ['operation.json', 'claimed', 'started']:
            owned = admit(); directory = self.updater.state / 'operations' / owned['jobId']
            if marker == 'started':
                with host.locked(self.updater.state / 'ledger.lock'):
                    self.updater.set_job(owned['jobId'], 'downloading')
            else:
                directory.mkdir(mode=0o700); (directory / marker).write_text('{}')
            with self.assertRaises(host.Failure) as error:
                self.updater.update_job(dict(params, jobId=owned['jobId']))
            self.assertEqual(error.exception.code, 'HOST_UPDATE_JOB_CONFLICT')
            self.assertEqual(self.updater.read_job(owned['jobId'])['state'], 'downloading' if marker == 'started' else 'queued')
        self.assertEqual(self.launches, [])

if __name__ == '__main__': unittest.main()
