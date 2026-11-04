#!/usr/bin/env python3
"""Bundled module installer: no Host setup, Docker socket or container restart."""
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import signal
import socket
import stat
import subprocess
import sys
import threading
import time


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host = load_module('bundled_host_protocol', 'container-update-host.py')
PREFIX = Path('/srv/bellteam-module-updater')
PRIVATE = Path('/srv/bellteam-private')
SOCKET = Path('/run/bellteam-updater')


def reconciliation_bytes(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def reconciliation_hash(value):
    return hashlib.sha256(reconciliation_bytes(value)).hexdigest()


DECISION_KEYS = 'schema,publicRequestId,publicPlanId,requestId,planId,originalOperationSha256,publicOperationSha256,inspectionSha256,targetSha256,storageBindingSha256,runtimeCurrentSha256,currentSha256,catalogSha256,action,issuedAt,expiresAt,ownerGrantRef'
PROOF_KEYS = 'schema,publicRequestId,publicPlanId,requestId,planId,originalOperationSha256,publicOperationSha256,decisionSha256,currentSha256,applyState,applyClaimSha256,resultSha256,claimedAt,verifiedAt,ownerGrantRef'
FENCE_KEYS = 'schema,requestId,planId,originalOperationSha256,decisionSha256,commonProofSha256,action,closedAt'


def reconciliation_envelope(value, kind, fields):
    host.check(host.exact(value, kind + 'Sha256,' + kind), 'HOST_MODULE_RECONCILIATION_ARGUMENTS')
    body = value[kind]
    host.check(host.exact(body, fields) and body['schema'] == 'bellteam.module-install-' + (
        'common-proof' if kind == 'proof' else kind) + '.v1', 'HOST_MODULE_RECONCILIATION_ARGUMENTS')
    host.check(host.digest(value[kind + 'Sha256']) == reconciliation_hash(body), 'HOST_MODULE_RECONCILIATION_HASH')
    for key in ['publicRequestId', 'publicPlanId', 'requestId', 'planId']:
        if key in body: host.request_id(body[key])
    for key, item in body.items():
        if key.endswith('Sha256') or key == 'ownerGrantRef':
            if item is not None or key not in {'applyClaimSha256', 'resultSha256'}: host.digest(item)
    return body


def reconciliation_json(path, uid):
    host.trusted(path, uid)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        host.check(before.st_size <= host.LIMIT, 'HOST_MODULE_RECONCILIATION_LIMIT')
        with os.fdopen(fd, 'rb', closefd=False) as stream: raw = stream.read(host.LIMIT + 1)
        after, linked = os.fstat(fd), path.lstat()
        identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        host.check(identity(before) == identity(after) == identity(linked) and len(raw) == before.st_size,
                   'HOST_MODULE_RECONCILIATION_CHANGED')
        return host.decode(raw), hashlib.sha256(raw).hexdigest()
    finally:
        os.close(fd)


@contextlib.contextmanager
def reconciliation_lock(path, uid, shared=False):
    info = host.trusted(path, uid, directory=shared)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        actual = os.fstat(fd)
        host.check((info.st_dev, info.st_ino) == (actual.st_dev, actual.st_ino), 'HOST_MODULE_STORAGE_BINDING')
        try: fcntl.flock(fd, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
        except BlockingIOError: raise host.Failure('HOST_UPDATE_BUSY', 409)
        yield
    finally:
        os.close(fd)


class ModuleUpdater(host.HostUpdater):
    def __init__(self, prefix, private, config, **dependencies):
        self.private = Path(private)
        super().__init__(prefix, config, **dependencies)
        self.env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'}

    @property
    def code_root(self):
        return Path('/app')

    def inspect_current(self):
        info = host.trusted(self.private, self.uid, directory=True)
        host.check(info.st_gid == 1001 and stat.S_IMODE(info.st_mode) == 0o750, 'HOST_MODULE_STORAGE_BINDING')
        return {'sourceCommit': self.config['release'], 'platform': self.config['platform'],
                'privateVolume': {'device': str(info.st_dev), 'inode': str(info.st_ino)}}

    def assert_model_binding(self, current, normal=None):
        host.check(current == self.inspect_current(), 'HOST_MODULE_STORAGE_BINDING')

    def module_volume(self, current, directory):
        self.assert_model_binding(current)
        return current['privateVolume']

    def target(self, *_args):
        raise host.Failure('HOST_CONTAINER_UPDATE_UNSUPPORTED', 400)

    def worker_identity(self, identifier):
        return {'pid': os.getpid(), 'birth': host.birth(os.getpid()),
                'pidNamespace': str(os.stat('/proc/self/ns/pid').st_ino)}

    def worker_alive(self, worker):
        return worker.get('pidNamespace') == str(os.stat('/proc/self/ns/pid').st_ino) and super().worker_alive(worker)

    def launch_service(self, identifier):
        host.request_id(identifier)
        child = subprocess.Popen(['/usr/bin/python3', '-I', '-B', str(Path(__file__).absolute()), '--worker', identifier],
                                 cwd='/', env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
        threading.Thread(target=child.wait, daemon=True).start()

    def capabilities(self):
        value = super().capabilities()
        value.update(moduleInstallSupported=value['supported'], moduleInstallReason=value['reason'],
                     moduleInstallerSource=self.config['release'], supported=False, reason='HOST_CONTAINER_UPDATE_UNSUPPORTED')
        return value

    def dispatch(self, frame):
        methods = {'inspectModuleInstall': self.inspect_module_install, 'readInstallReconciliation': self.read_install_reconciliation,
            'finalizeInstallReconciliation': self.finalize_install_reconciliation,
            'readInstallReconciliationFence': self.read_install_reconciliation_fence}
        if isinstance(frame, dict) and frame.get('operation') in methods:
            host.check(host.exact(frame, 'operation,params'))
            return methods[frame['operation']](frame['params'])
        if isinstance(frame, dict) and frame.get('operation') == 'catalog' and frame.get('params') == {'componentId': 'container'}:
            raise host.Failure('HOST_CONTAINER_UPDATE_UNSUPPORTED', 400)
        return super().dispatch(frame)

    def reconciliation_origin(self, params):
        host.check(host.exact(params, 'requestId,originalOperationSha256'))
        identifier, original = host.request_id(params['requestId']), host.digest(params['originalOperationSha256'])
        directory = self.state / 'operations' / identifier
        value, observed = reconciliation_json(directory / 'operation.json', self.uid)
        host.check(observed == original, 'HOST_MODULE_ORIGINAL_CHANGED', 409)
        host.check(value['requestId'] == identifier and value['admission'] == 'accepted' and value['phase'] == 'unknown',
                   'HOST_MODULE_RECONCILIATION_STATE', 409)
        plan, plan_sha = reconciliation_json(self.state / 'plans' / (host.request_id(value['planId']) + '.json'), self.uid)
        host.check(plan['planId'] == value['planId'] and plan['target'] == value['target']
                   and plan['target']['componentId'] == 'execution', 'HOST_MODULE_RECONCILIATION_TARGET', 409)
        target = plan['target']
        installer = load_module('inspection_fixed_installer', 'install-web-gateway-release.py')
        installer.expectation(target['versionId'], target['sourceCommit'], target['artifact']['signerCommit'])
        host.check(target['artifact']['archive']['sha256'] == target['versionId'], 'HOST_MODULE_RECONCILIATION_TARGET')
        volume, _ = reconciliation_json(directory / 'module-volume.json', self.uid)
        host.check(volume == plan['expected']['privateVolume'], 'HOST_MODULE_STORAGE_BINDING')
        return directory, value, plan, plan_sha, installer

    def reconciliation_worker_quiescent(self, value, directory=None, plan=None, plan_sha=None):
        worker = value.get('worker')
        host.check(host.exact(worker, 'pid,birth,pidNamespace') and type(worker['pid']) is int and worker['pid'] > 0
            and isinstance(worker['birth'], str) and re.fullmatch('[0-9]+', worker['birth'])
            and isinstance(worker['pidNamespace'],str) and re.fullmatch('[0-9]+',worker['pidNamespace']),
            'HOST_MODULE_WORKER_UNCONFIRMED', 409)
        # Namespace change alone is never evidence; only the fixed installer's bound durable receipt is.
        bridge_record = directory is not None and any(os.path.lexists(directory/name) for name in ['worker-termination-prepare.json','worker-termination.json'])
        if bridge_record or worker['pidNamespace'] != str(os.stat('/proc/self/ns/pid').st_ino):
            host.check(directory is not None and plan is not None and plan_sha is not None, 'HOST_MODULE_WORKER_UNCONFIRMED',409)
            bridge=load_module('module_worker_termination','module-worker-termination.py')
            return bridge.read_termination(self,host,directory,value,plan,plan_sha)
        try:
            birth = Path(f"/proc/{worker['pid']}/stat").read_text().rsplit(')', 1)[1].split()[19]
        except FileNotFoundError:
            return
        except (OSError, IndexError):
            raise host.Failure('HOST_MODULE_WORKER_UNCONFIRMED', 409)
        host.check(birth != worker['birth'], 'HOST_UPDATE_BUSY', 409)

    def read_install_reconciliation(self, params):
        directory, _value, _plan, _plan_sha, _installer = self.reconciliation_origin(params)
        location = directory / 'reconciliation'
        if not (location / 'latest.json').exists():
            raise host.Failure('HOST_MODULE_RECONCILIATION_NOT_FOUND', 404)
        pointer = host.read_json(location / 'latest.json', self.uid)
        host.check(host.exact(pointer, 'receiptSha256'))
        receipt_sha = host.digest(pointer['receiptSha256'])
        receipt, observed = reconciliation_json(location / (receipt_sha + '.json'), self.uid)
        host.check(observed == receipt_sha and receipt['requestId'] == params['requestId']
                   and receipt['originalOperationSha256'] == params['originalOperationSha256'],
                   'HOST_MODULE_RECONCILIATION_CHANGED')
        return {'receiptSha256': receipt_sha, 'receipt': receipt}

    def inspect_module_install(self, params):
        directory, value, plan, plan_sha, installer = self.reconciliation_origin(params)
        target = plan['target']
        placement, quiescence, stages, manifest_sha, reason = 'unconfirmed', 'unconfirmed', 'unconfirmed', None, None
        current = self.inspect_current()
        host.check(current['privateVolume'] == plan['expected']['privateVolume'], 'HOST_MODULE_STORAGE_BINDING', 409)
        recovery_state, fence, termination_sha = 'not_issued', 'open', None
        try:
            with contextlib.ExitStack() as locks:
                locks.enter_context(reconciliation_lock(self.state / 'worker.lock', self.uid))
                locks.enter_context(reconciliation_lock(self.state / 'ledger.lock', self.uid))
                self.reconciliation_origin(params)
                locks.enter_context(reconciliation_lock(self.private, self.uid, shared=True))
                host.check(not os.path.lexists(self.private / '.transaction.json'), 'HOST_UPDATE_BUSY', 409)
                component = self.private / 'execution'
                locks.enter_context(reconciliation_lock(component / '.install.lock', self.uid))
                self.assert_model_binding(current)
                termination_sha = self.reconciliation_worker_quiescent(value,directory,plan,plan_sha)
                host.check(not any(path.name.startswith('.staging-') for path in component.iterdir()),
                           'HOST_MODULE_UNOWNED_STAGE', 409)
                stages = 'clear'
                claim_path = directory / 'recovery-claim.json'
                if os.path.lexists(claim_path):
                    recovery_state = 'unknown'
                    raise host.Failure('HOST_MODULE_RECOVERY_UNCONFIRMED', 409)
                fence_path = directory / 'reconciliation-fence.json'
                if os.path.lexists(fence_path):
                    self.read_install_reconciliation_fence(params)
                    fence = 'closed'
                quiescence = 'confirmed'
                expected = installer.expectation(target['versionId'], target['sourceCommit'], target['artifact']['signerCommit'])
                manifest_sha = installer.inspect_execution_release(self.private, expected, self.config['platform']['arch'])
                placement = 'verified_present' if manifest_sha else 'absent'
                self.assert_model_binding(current)
                self.reconciliation_origin(params)
        except host.Failure as error:
            reason = error.code if error.code in {'HOST_UPDATE_BUSY', 'HOST_MODULE_UNOWNED_STAGE',
                'HOST_MODULE_RECOVERY_UNCONFIRMED'} else 'HOST_MODULE_INSPECTION_UNCONFIRMED'
            quiescence = 'busy' if error.code == 'HOST_UPDATE_BUSY' else 'unconfirmed'
        except (OSError, ValueError, KeyError, TypeError):
            reason = 'HOST_MODULE_INSPECTION_UNCONFIRMED'
        receipt = dict(schema='bellteam.module-install-inspection.v1', requestId=params['requestId'], planId=plan['planId'],
            componentId='execution', versionId=target['versionId'], sourceCommit=target['sourceCommit'],
            originalOperationSha256=params['originalOperationSha256'], planSha256=plan_sha,
            targetSha256=reconciliation_hash(target), storageBindingSha256=reconciliation_hash(current['privateVolume']),
            runtimeCurrentSha256=reconciliation_hash(current), inspectionTime=host.stamp(), placement=placement,
            quiescence=quiescence, stageState=stages, manifestSha256=manifest_sha, recoveryState=recovery_state,
            fence=fence, evidenceSha256=reconciliation_hash(dict(current=current, target=target, planSha256=plan_sha,
                placement=placement, manifestSha256=manifest_sha, stageState=stages, recoveryState=recovery_state, fence=fence, workerTerminationSha256=termination_sha)),
            reason=reason)
        receipt_sha = reconciliation_hash(receipt)
        with host.locked(self.state / 'ledger.lock', wait=True):
            self.reconciliation_origin(params)
            location = directory / 'reconciliation'
            location.mkdir(mode=0o700, exist_ok=True)
            host.trusted(location, self.uid, directory=True)
            path = location / (receipt_sha + '.json')
            if not path.exists(): host.atomic(path, json.loads(reconciliation_bytes(receipt)))
            host.atomic(location / 'latest.json', {'receiptSha256': receipt_sha})
        return {'receiptSha256': receipt_sha, 'receipt': receipt}

    def reconciliation_decision(self, params):
        origin = {'requestId': params['requestId'], 'originalOperationSha256': params['originalOperationSha256']}
        directory, value, plan, plan_sha, installer = self.reconciliation_origin(origin)
        envelope = params['decision']
        decision = reconciliation_envelope(envelope, 'decision', DECISION_KEYS)
        current = self.inspect_current()
        issued, expires = host.parse_time(decision['issuedAt']), host.parse_time(decision['expiresAt'])
        claim_time = time.time()
        host.check(issued <= claim_time <= expires and 0 < expires - issued <= 600 and issued <= time.time(),
                   'HOST_MODULE_DECISION_EXPIRED', 409)
        host.check(decision['action'] == 'close_without_activation' and decision['requestId'] == params['requestId']
            and decision['planId'] == plan['planId'] and decision['originalOperationSha256'] == params['originalOperationSha256']
            and decision['targetSha256'] == reconciliation_hash(plan['target'])
            and current['privateVolume'] == plan['expected']['privateVolume']
            and decision['storageBindingSha256'] == reconciliation_hash(current['privateVolume'])
            and decision['runtimeCurrentSha256'] == reconciliation_hash(current), 'HOST_MODULE_DECISION_CHANGED', 409)
        location = directory / 'reconciliation' / (host.digest(decision['inspectionSha256']) + '.json')
        receipt, observed = reconciliation_json(location, self.uid)
        host.check(observed == decision['inspectionSha256'] and receipt['requestId'] == params['requestId']
            and receipt['originalOperationSha256'] == params['originalOperationSha256']
            and receipt['targetSha256'] == decision['targetSha256']
            and receipt['storageBindingSha256'] == decision['storageBindingSha256']
            and receipt['runtimeCurrentSha256'] == decision['runtimeCurrentSha256']
            and receipt['quiescence'] == 'confirmed' and receipt['stageState'] == 'clear'
            and receipt['recoveryState'] != 'unknown' and receipt['fence'] == 'open', 'HOST_MODULE_PROOF_UNCONFIRMED', 409)
        host.check(host.parse_time(receipt['inspectionTime']) <= issued, 'HOST_MODULE_DECISION_CHANGED', 409)
        self.catalog(decision['catalogSha256'])
        return origin, directory, value, plan, plan_sha, installer, decision, receipt

    def read_install_reconciliation_fence(self, params):
        directory, _value, plan, _sha, _installer = self.reconciliation_origin(params)
        path = directory / 'reconciliation-fence.json'
        if not path.exists(): raise host.Failure('HOST_MODULE_RECONCILIATION_NOT_FOUND', 404)
        envelope = host.read_json(path, self.uid)
        fence = reconciliation_envelope(envelope, 'fence', FENCE_KEYS)
        host.check(fence['requestId'] == params['requestId'] and fence['planId'] == plan['planId']
            and fence['originalOperationSha256'] == params['originalOperationSha256']
            and fence['action'] == 'close_without_activation', 'HOST_MODULE_FENCE_INVALID')
        host.parse_time(fence['closedAt'])
        return envelope

    def operation_pending(self, identifier):
        if not super().operation_pending(identifier): return False
        directory = self.state / 'operations' / host.request_id(identifier)
        if not os.path.lexists(directory / 'reconciliation-fence.json'): return True
        _value, original = reconciliation_json(directory / 'operation.json', self.uid)
        self.read_install_reconciliation_fence(dict(requestId=identifier, originalOperationSha256=original))
        return False

    def finalize_install_reconciliation(self, params):
        host.check(host.exact(params, 'requestId,originalOperationSha256,decision,commonProof'))
        proof = reconciliation_envelope(params['commonProof'], 'proof', PROOF_KEYS)
        origin, directory, value, plan, _sha, installer, decision, receipt = self.reconciliation_decision(params)
        host.check(proof['decisionSha256'] == params['decision']['decisionSha256'] and all(proof[key] == decision[key] for key in [
            'publicRequestId','publicPlanId','requestId','planId','originalOperationSha256','publicOperationSha256','currentSha256','ownerGrantRef']),
            'HOST_MODULE_COMMON_PROOF_CHANGED', 409)
        claim_time, verified_time = host.parse_time(proof['claimedAt']), host.parse_time(proof['verifiedAt'])
        host.check(host.parse_time(decision['issuedAt']) <= claim_time <= host.parse_time(decision['expiresAt'])
            and claim_time <= verified_time <= time.time(), 'HOST_MODULE_COMMON_PROOF_CHANGED', 409)
        host.check(proof['applyState'] == 'not_issued' and proof['applyClaimSha256'] is None
            and proof['resultSha256'] is None, 'HOST_MODULE_COMMON_PROOF_CHANGED', 409)
        observed = self.inspect_module_install(origin)['receipt']
        host.check(observed['quiescence'] == 'confirmed' and observed['stageState'] == 'clear' and observed['fence'] == 'open'
            and observed['placement'] in {'verified_present', 'absent'}, 'HOST_MODULE_PROOF_UNCONFIRMED', 409)
        with reconciliation_lock(self.state / 'worker.lock', self.uid), host.locked(self.state / 'ledger.lock', wait=True), contextlib.ExitStack() as locks:
            locks.enter_context(reconciliation_lock(self.private, self.uid, shared=True))
            locks.enter_context(reconciliation_lock(self.private / 'execution/.install.lock', self.uid))
            self.reconciliation_decision(params)
            self.reconciliation_worker_quiescent(value,directory,plan,_sha)
            host.check(not os.path.lexists(self.private / '.transaction.json') and not any(
                p.name.startswith('.staging-') for p in (self.private / 'execution').iterdir()), 'HOST_MODULE_PROOF_UNCONFIRMED', 409)
            host.check(not os.path.lexists(directory / 'recovery-claim.json'), 'HOST_MODULE_RECOVERY_UNCONFIRMED', 409)
            target = plan['target']
            expected = installer.expectation(target['versionId'], target['sourceCommit'], target['artifact']['signerCommit'])
            installer.inspect_execution_release(self.private, expected, self.config['platform']['arch'])
            host.check(not os.path.lexists(directory / 'reconciliation-fence.json'), 'HOST_MODULE_INTENT_CLOSED', 409)
            fence = dict(schema='bellteam.module-install-fence.v1', requestId=params['requestId'], planId=decision['planId'],
                originalOperationSha256=params['originalOperationSha256'], decisionSha256=params['decision']['decisionSha256'],
                commonProofSha256=params['commonProof']['proofSha256'], action='close_without_activation', closedAt=host.stamp())
            result = {'fenceSha256': reconciliation_hash(fence), 'fence': fence}
            try:
                installer.write_file(directory / 'reconciliation-fence.json', reconciliation_bytes(result), 0o600)
                installer.sync_directory(directory)
            except OSError: raise host.Failure('HOST_MODULE_FENCE_UNKNOWN', 503, 'unknown')
        return result

    def install(self, plan, directory):
        target = plan['target']
        host.check(target['componentId'] in host.MODULES, 'HOST_MODULE_TARGET_INVALID')
        incoming = host.module_inputs(self, target)
        host.check(self.planned_target(plan) == target, 'HOST_UPDATE_PLAN_CHANGED')
        self.assert_model_binding(plan['expected'])
        installer = load_module('bundled_fixed_installer', 'install-web-gateway-release.py')
        expected = installer.expectation(target['versionId'], target['sourceCommit'], target['artifact']['signerCommit'])
        result = installer.install(self.private, incoming.parent, expected, target['componentId'])
        host.check(result == {'versionId': target['versionId'], 'installed': True}, 'HOST_MODULE_INSTALL_UNKNOWN')
        self.assert_model_binding(plan['expected'])
        cleanup, error = 'succeeded', None
        try:
            import shutil
            shutil.rmtree(incoming)
        except OSError:
            cleanup, error = 'failed', 'HOST_MODULE_CLEANUP_FAILED'
        return {'execution': 'succeeded', 'verification': 'succeeded', 'cleanup': cleanup,
                'rollback': 'not_needed', 'observed': self.inspect_current(), 'error': error}


def load():
    host.check(os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 0, 'HOST_UPDATE_ROOT_REQUIRED')
    os.umask(0o077)
    host.trusted('/app', directory=True)
    distribution = host.read_json('/app/distribution.json')
    source = distribution.get('sourceCommit')
    host.check(distribution.get('schema') == 'bellteam.server.distribution.v1' and isinstance(source, str)
               and re.fullmatch('[a-f0-9]{40}', source), 'HOST_MODULE_SOURCE_INVALID')
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    host.check(arch is not None and sys.platform == 'linux', 'HOST_MODULE_PLATFORM_UNSUPPORTED')
    host.trusted(PREFIX, directory=True)
    for name in ['state', 'catalog']:
        (PREFIX / name).mkdir(mode=0o700, exist_ok=True)
        host.trusted(PREFIX / name, directory=True)
    updater = ModuleUpdater(PREFIX, PRIVATE, {'release': source, 'platform': {'os': 'linux', 'arch': arch}, 'python': '/usr/bin/python3'})
    updater.inspect_current()
    return updater


def health(updater, socket_directory):
    # Socket is published only after a verified catalog has been accepted.
    host.check(stat.S_ISSOCK((socket_directory / 'update.sock').lstat().st_mode), 'HOST_MODULE_SOCKET_UNAVAILABLE')
    updater.catalog(host.read_json(updater.prefix / 'catalog/state.json')['catalogSha256'])
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(4)
        probe.connect(str(socket_directory / 'update.sock'))
    return

def serve(updater, socket_directory):
    host.trusted(socket_directory, directory=True)
    os.chown(socket_directory, 0, 1001)
    os.chmod(socket_directory, 0o750)
    with host.locked(updater.state / 'daemon.lock'):
        host.refresh_catalog(updater)
        path = socket_directory / 'update.sock'
        if os.path.lexists(path):
            info = path.lstat()
            host.check(stat.S_ISSOCK(info.st_mode) and info.st_uid == 0, 'HOST_UPDATE_SOCKET_INVALID')
            path.unlink()
        with host.Server(str(path), updater) as server:
            os.chown(path, 0, 1001)
            os.chmod(path, 0o660)
            def close(_signum, _frame):
                threading.Thread(target=server.shutdown, daemon=True).start()
            signal.signal(signal.SIGTERM, close)
            signal.signal(signal.SIGINT, close)
            stop = threading.Event()
            def refresh():
                while not stop.wait(900):
                    try: host.refresh_catalog(updater)
                    except Exception: pass # Durable refresh.json records failure; accepted catalog still expires.
            threading.Thread(target=refresh, daemon=True).start()
            inode = path.lstat().st_ino
            try: server.serve_forever(poll_interval=0.2)
            finally:
                stop.set()
                if os.path.lexists(path) and path.lstat().st_ino == inode: path.unlink()


def main():
    updater = load()
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        updater.worker(sys.argv[2]); return
    if len(sys.argv) == 2 and sys.argv[1] == '--health':
        health(updater, SOCKET); return
    host.check(len(sys.argv) == 1)
    serve(updater, SOCKET)


if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt) as error:
        code = error.code if isinstance(error, host.Failure) and re.fullmatch('[A-Z_0-9]{1,100}', error.code) else 'MODULE_INSTALLER_STOPPED'
        sys.stderr.write(code + '\n')
        sys.exit(1)
