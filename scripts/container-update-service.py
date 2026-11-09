#!/usr/bin/env python3
"""Bundled container updater; only this service and its fixed worker own Docker access."""
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import sys


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bundled = load_module('bundled_update_server', 'module-update-service.py')
host = bundled.host
PREFIX = Path('/srv/bellteam-container-updater')
SOCKET = Path('/run/bellteam-container-updater')
ENTRY = '/app/scripts/container-update-service.py'
DOCKER = '/usr/local/bin/docker'


class ContainerUpdater(host.HostUpdater):
    @property
    def code_root(self):
        return Path('/app')

    def module_target(self, *_args):
        raise host.Failure('HOST_MODULE_INSTALL_UNAVAILABLE', 400)

    def assert_model_binding(self, current, normal=None):
        normal = normal or host.read_json(self.prefix / 'installation/normal.json', limit=host.CATALOG_LIMIT)
        # Compose saves literal dollars escaped; inspect reports the resolved path.
        normal = host.decode(json.dumps(normal).replace('$$', '$'))
        storage = self.storage_metadata(current['containerId'])
        host.verify_model_mounts(normal, storage['mounts'], storage['specs'])

    def worker_name(self, identifier):
        return self.config['projectName'] + '-container-worker-' + host.request_id(identifier)

    def worker_record(self, identifier, expected_image=None):
        expected_image = expected_image or self.config['workerImage']
        host.check(type(expected_image) is str and re.fullmatch('sha256:[a-f0-9]{64}', expected_image), 'HOST_UPDATE_WORKER_IDENTITY')
        record = host.decode(self.command([DOCKER, 'container', 'inspect', '--format',
            '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"started":{{json .State.StartedAt}},"labels":{{json .Config.Labels}}}',
            self.worker_name(identifier)]))
        host.check(re.fullmatch('[a-f0-9]{64}', record.get('id', ''))
                   and record['image'] == expected_image
                   and record['labels'].get('bellteam.container-update.request') == identifier
                   and record['labels'].get('bellteam.container-update.project') == self.config['projectName'],
                   'HOST_UPDATE_WORKER_IDENTITY')
        return record

    def worker_identity(self, identifier):
        record = self.worker_record(identifier)
        host.check(record['running'] is True, 'HOST_UPDATE_WORKER_IDENTITY')
        return {'requestId': identifier, 'containerId': record['id'], 'imageId': record['image'], 'startedAt': record['started']}

    def worker_alive(self, worker):
        try:
            record = self.worker_record(worker['requestId'], worker['imageId'])
            return (record['running'] is True and record['id'] == worker['containerId']
                    and record['image'] == worker['imageId'] and record['started'] == worker['startedAt'])
        except Exception:
            return False

    def launch_service(self, identifier):
        config = self.config
        # The independent Docker container survives replacement of the admission service and BellTeam.
        self.command([DOCKER, 'run', '--detach', '--rm', '--init',
            '--name', self.worker_name(identifier), '--label', 'bellteam.container-update.request=' + identifier,
            '--label', 'bellteam.container-update.project=' + config['projectName'],
            '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
            '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges:true',
            '--cpus', '1', '--memory', '2g', '--memory-swap', '2g', '--pids-limit', '512',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
            '--mount', 'type=volume,source=' + config['volumeName'] + ',target=' + str(PREFIX) + ',volume-nocopy',
            '--mount', 'type=volume,source=' + config['volumeName'] + ',target=' + config['volumeRoot'] + ',volume-nocopy',
            '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
            '--entrypoint', '/usr/bin/python3', config['workerImage'], '-I', '-B', ENTRY, '--worker', identifier], timeout=5)

    def capabilities(self):
        result = super().capabilities()
        result.update(moduleInstallSupported=False, moduleInstallReason='HOST_MODULE_INSTALL_UNAVAILABLE')
        if result['supported']:
            pointer = host.read_json(self.prefix / 'catalog/state.json')
            if not any(row['componentId'] == 'container' and row['platform'] == self.config['platform']
                       for row in self.catalog(pointer['catalogSha256'])['releases']):
                result.update(supported=False, reason='HOST_UPDATE_TARGET_UNAVAILABLE')
        return result

    def dispatch(self, frame):
        if isinstance(frame, dict) and frame.get('operation') == 'catalog':
            host.check(frame.get('params') == {'componentId': 'container'})
        return super().dispatch(frame)

    def install(self, plan, directory):
        host.check(plan['target']['componentId'] == 'container', 'HOST_UPDATE_TARGET_UNAVAILABLE')
        root = Path(self.config['volumeRoot'])
        host.trusted(root, directory=True)
        for child in [root / 'tmp', Path(self.config['installRoot'])]:
            child.mkdir(mode=0o700, parents=True, exist_ok=True)
            host.trusted(child, directory=True)
        self.env.update(TMPDIR=str(root / 'tmp'), BELLTEAM_CONTAINER_UPDATE_WORKER='1')
        return host.execute_installer(self, plan, directory)


def volume(updater, name, project):
    value = host.decode(updater.command([DOCKER, 'volume', 'inspect', '--format', '{{json .}}', name]))
    host.check(value.get('Name') == name and value.get('Driver') == 'local'
               and (value.get('Options') is None or type(value['Options']) is dict and value['Options'] == {})
               and value.get('Labels', {}).get('com.docker.compose.project') == project
               and value.get('Labels', {}).get('com.docker.compose.volume') == 'container-updater'
               and type(value.get('Mountpoint')) is str
               and re.fullmatch(r'/[A-Za-z0-9/._-]+', value['Mountpoint'])
               and all(part not in {'.', '..'} for part in value['Mountpoint'].split('/')),
               'HOST_UPDATE_STORAGE_BINDING')
    return value['Mountpoint']


def distribution():
    host.check(os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 0, 'HOST_UPDATE_ROOT_REQUIRED')
    os.umask(0o077)
    host.trusted('/app', directory=True)
    host.trusted(DOCKER)
    value = host.read_json('/app/distribution.json')
    host.check(value.get('schema') == 'bellteam.server.distribution.v1'
               and re.fullmatch('[a-f0-9]{40}', value.get('sourceCommit', '')), 'HOST_MODULE_SOURCE_INVALID')
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine())
    host.check(arch is not None and sys.platform == 'linux', 'HOST_MODULE_PLATFORM_UNSUPPORTED')
    host.trusted(PREFIX, directory=True)
    for name in ['state', 'catalog', 'installation']:
        (PREFIX / name).mkdir(mode=0o700, exist_ok=True)
        host.trusted(PREFIX / name, directory=True)
    return value['sourceCommit'], {'os': 'linux', 'arch': arch}


def configure():
    source, native = distribution()
    raw = sys.stdin.buffer.read(host.CATALOG_LIMIT + 1)
    host.check(len(raw) <= host.CATALOG_LIMIT, 'HOST_UPDATE_MODEL_INVALID')
    normal = host.decode(raw)
    project = normal.get('name')
    host.check(type(project) is str and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}', project)
               and type(normal.get('services')) is dict and 'bellteam' in normal['services'], 'HOST_UPDATE_MODEL_INVALID')
    image = normal['services']['bellteam'].get('image')
    host.check(type(image) is str and re.fullmatch('sha256:[a-f0-9]{64}', image), 'HOST_UPDATE_IMAGE_INVALID')
    channel = (normal['services']['bellteam'].get('environment') or {}).get('BELLTEAM_UPDATE_CHANNEL', 'stable')
    host.check(channel in ('stable', 'candidate'), 'HOST_UPDATE_CHANNEL_INVALID')
    config = {'schema': 'bellteam.bundled-container-updater.v1', 'release': source, 'platform': native,
              'projectName': project, 'workerImage': image, 'volumeName': project + '-container-updater',
              'docker': DOCKER, 'python': '/usr/bin/python3', 'shell': '/bin/sh', 'channel': channel}
    updater = ContainerUpdater(PREFIX, config)
    config['volumeRoot'] = volume(updater, config['volumeName'], project)
    config['installRoot'] = config['volumeRoot'] + '/installation/work'
    current = updater.inspect_current()
    host.check(current['imageId'] == image and current['sourceCommit'] == source and current['health'] == 'healthy',
               'HOST_UPDATE_CURRENT_CHANGED')
    updater.assert_model_binding(current, normal)
    with host.locked(updater.state / 'ledger.lock', wait=True):
        host.atomic(PREFIX / 'installation/normal.json', normal, host.CATALOG_LIMIT)
        host.atomic(PREFIX / 'config.json', config)


def load():
    source, native = distribution()
    config = host.read_json(PREFIX / 'config.json')
    keys = 'schema,release,platform,projectName,workerImage,volumeName,docker,python,shell,volumeRoot,installRoot'
    # channel is absent in configs written before the candidate channel existed (= stable).
    host.check((host.exact(config, keys) or host.exact(config, keys + ',channel') and config['channel'] in ('stable', 'candidate'))
               and config['schema'] == 'bellteam.bundled-container-updater.v1' and config['release'] == source
               and config['platform'] == native and config['docker'] == DOCKER
               and config['python'] == '/usr/bin/python3' and config['shell'] == '/bin/sh'
               and type(config['projectName']) is str and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}', config['projectName'])
               and type(config['workerImage']) is str and re.fullmatch('sha256:[a-f0-9]{64}', config['workerImage'])
               and config['volumeName'] == config['projectName'] + '-container-updater'
               and config['installRoot'] == config['volumeRoot'] + '/installation/work', 'HOST_UPDATE_CONFIG_INVALID')
    updater = ContainerUpdater(PREFIX, config)
    host.check(volume(updater, config['volumeName'], config['projectName']) == config['volumeRoot'], 'HOST_UPDATE_STORAGE_BINDING')
    return updater


def main():
    if sys.argv[1:] == ['--configure']:
        configure(); return
    updater = load()
    if len(sys.argv) == 3 and sys.argv[1] == '--worker':
        updater.worker(sys.argv[2]); return
    if sys.argv[1:] == ['--health']:
        bundled.health(updater, SOCKET); return
    host.check(len(sys.argv) == 1)
    bundled.serve(updater, SOCKET)


if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt) as error:
        code = error.code if isinstance(error, host.Failure) and re.fullmatch('[A-Z_0-9]{1,100}', error.code) else 'CONTAINER_UPDATER_STOPPED'
        sys.stderr.write(code + '\n'); sys.exit(1)
