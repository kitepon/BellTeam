#!/usr/bin/env python3
"""Put a body in when the body cannot start (docs/architecture/modules/runtime/emergency-body.md).

Runs inside the TARGET image, started by distribution/server/emergency-body.sh like an update worker.
Same installer as App Update (ContainerUpdater.install); only the parts that need a live old body are replaced.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import socket
import sys
import uuid


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


service = load_module('container_service', 'container-update-service.py')
host = service.host
PUBLISHED = 'ghcr.io/kitepon/bellteam-server@sha256:[a-f0-9]{64}'
LOCAL = 'sha256:[a-f0-9]{64}'
ABSENT = {'storageBinding': 'absent', 'containerId': '0' * 64, 'imageId': 'sha256:' + '0' * 64, 'imageRef': None, 'health': 'unavailable', 'sourceCommit': '0' * 40}


class EmergencyUpdater(service.ContainerUpdater):
    """The old body may be in any state, so its snapshot is taken once and returned while that container exists."""
    old = None

    def project_containers(self):
        name = self.config['projectName']
        return self.command([self.config['docker'], 'ps', '-a', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + name,
                             '--filter', 'label=com.docker.compose.service=bellteam', '--format', '{{.ID}}']).decode().split()

    def snapshot_old(self):
        ids = self.project_containers()
        if not ids:
            # An aborted or killed earlier run can leave no body at all (install.sh removes the old one before it starts the new one).
            # The saved model and the state volumes are intact, so the same installer starts a body from them (no rollback exists).
            self.old = dict(ABSENT)
            return self.old, 'absent'
        host.check(len(ids) == 1 and re.fullmatch('[a-f0-9]{64}', ids[0]), 'EMERGENCY_BODY_NOT_FOUND')
        docker = self.config['docker']
        row = host.decode(self.command([docker, 'container', 'inspect', '--format',
            '{"image":{{json .Image}},"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"status":{{json .State.Status}}}', ids[0]]))
        label = self.command([docker, 'image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', row['image']]).decode().strip()
        storage = self.storage_metadata(ids[0])
        binding = hashlib.sha256(json.dumps(storage, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        # health is left out on purpose: it changes while a failing body restarts, and the expected value must stay equal.
        self.old = {'storageBinding': binding, 'containerId': ids[0], 'imageId': row['image'], 'imageRef': None, 'health': 'unavailable',
                    'sourceCommit': label if re.fullmatch('[a-f0-9]{40}', label) else '0' * 40}
        return self.old, row['status']

    def inspect_current(self):
        ids = self.project_containers()
        if self.old and ids == ([] if self.old == ABSENT else [self.old['containerId']]):
            return self.old  # the body being replaced, whatever its state (or no body at all)
        return super().inspect_current()  # a new or restored body must be running and healthy

    def progress(self, directory, state):
        print('progress=' + state, flush=True)


def parse(argv):
    local = '--local' in argv
    rest = [value for value in argv if value != '--local']
    host.check(len(rest) == 1 and re.fullmatch(LOCAL if local else PUBLISHED, rest[0]), 'EMERGENCY_REFERENCE_INVALID')
    return rest[0], local


def emergency(updater, reference, local, own_source, own_image):
    docker = updater.config['docker']
    target = updater.command([docker, 'image', 'inspect', '--format', '{{.Id}}', reference]).decode().strip()
    # The installer code is /app of this container; it must be the code of the image being put in.
    host.check(re.fullmatch('sha256:[a-f0-9]{64}', target) and target == own_image, 'EMERGENCY_IMAGE_MISMATCH')
    busy = updater.command([docker, 'ps', '-q', '--filter', 'label=bellteam.container-update.project=' + updater.config['projectName']]).decode().split()
    host.check(not busy, 'EMERGENCY_UPDATE_RUNNING')
    expected, status = updater.snapshot_old()
    identifier = str(uuid.uuid4())
    plan = {'planId': identifier, 'expected': expected,
            'target': {'componentId': 'container', 'sourceCommit': own_source,
                       'artifact': {'kind': 'oci-index', 'reference': reference, **({'local': True} if local else {})}}}
    directory = updater.state / 'operations' / identifier
    directory.mkdir(mode=0o700, parents=True)
    result = updater.install(plan, directory)
    log = directory / 'installer.log'
    return {'result': {key: result[key] for key in ('execution', 'verification', 'cleanup', 'rollback', 'error')},
            'previous': {'state': status}, 'installerLog': log.read_text(errors='replace')[-20000:] if log.exists() else ''}


def main(argv):
    reference, local = parse(argv)
    updater = service.load(EmergencyUpdater, release_must_match=False)
    source, _native = service.distribution()
    own_image = updater.command([updater.config['docker'], 'container', 'inspect', '--format', '{{.Image}}', socket.gethostname()]).decode().strip()
    outcome = emergency(updater, reference, local, source, own_image)
    print(json.dumps(outcome))
    return 0 if outcome['result']['verification'] == 'succeeded' else 1


if __name__ == '__main__':
    try: sys.exit(main(sys.argv[1:]))
    except (Exception, KeyboardInterrupt) as error:
        code = error.code if isinstance(error, host.Failure) and re.fullmatch('[A-Z_0-9]{1,100}', error.code) else 'EMERGENCY_BODY_STOPPED'
        sys.stderr.write(code + '\n'); sys.exit(1)
