#!/usr/bin/env python3
"""Bundled module installer: no Host setup, Docker socket or container restart."""
import importlib.util
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


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host = load_module('bundled_host_protocol', 'container-update-host.py')
PREFIX = Path('/srv/bellteam-module-updater')
PRIVATE = Path('/srv/bellteam-private')
SOCKET = Path('/run/bellteam-updater')


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
        if isinstance(frame, dict) and frame.get('operation') == 'catalog' and frame.get('params') == {'componentId': 'container'}:
            raise host.Failure('HOST_CONTAINER_UPDATE_UNSUPPORTED', 400)
        return super().dispatch(frame)

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
