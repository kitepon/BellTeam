"""Fixed phase caller; real phase executors and a production CLI are not connected."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re


_spec = importlib.util.spec_from_file_location(
    'sec014_control', Path(__file__).with_name('sec014-host-control.py'))
control = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(control)
_spec = importlib.util.spec_from_file_location(
    'sec014_prepared_producer', Path(__file__).with_name('sec014-prepared-proof.py'))
prepared = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prepared)

# Each proof is produced after checking its real artifacts, never from exit0 alone.
PROOFS = (
    ('host_parents', 'six_prepared_leaves'),
    ('participating_writers', 'nonparticipating_writers', 'both_normal_stopped'),
    ('legacy_backup', 'server_backup', 'current_direction_migration'),
    ('six_source_target_identity', 'normal_nonexposure', 'socket_boundary'),
    ('owner_operation', 'selected_normal_identity', 'no_other_normal'),
    ('health', 'current_data', 'no_unknown_children'),
)


def _receipt(tx, phase, image, value, required):
    if (type(value) is not dict
            or set(value) != {'schema', 'direction', 'phase', 'image', 'actorPid',
                             'actorStartTicks', 'status', 'proofs'}
            or value['schema'] != 'bellteam.sec014.phase-receipt.v1'
            or value['direction'] != tx.value['direction']
            or value['phase'] != phase or value['image'] != image
            or type(value['actorPid']) is not int
            or value['actorPid'] != tx.value['actorPid']
            or type(value['actorStartTicks']) is not int
            or value['actorStartTicks'] != tx.value['actorStartTicks']
            or value['status'] != 'verified' or type(value['proofs']) is not dict
            or set(value['proofs']) != set(required)
            or any(type(sha) is not str or not re.fullmatch('[a-f0-9]{64}', sha)
                   for sha in value['proofs'].values())):
        raise control.ControlError('SEC014_ACTOR_PHASE_UNCONFIRMED')
    name = tx.value['direction'] + '-' + phase + '.receipt.json'
    return _save_json(tx, name, value)


def _save_json(tx, name, value):
    raw = json.dumps(value, sort_keys=True, allow_nan=False).encode()
    tx.check()
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                 | os.O_CLOEXEC, 0o600, dir_fd=tx.parent)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
        written = os.fstat(stream.fileno())
        control._private(written, tx.owner)
        os.fsync(tx.parent)
        if control._saved(tx.parent, name, tx.owner) != value:
            raise control.ControlError('SEC014_ACTOR_RECEIPT_CHANGED')
        # Equal JSON in a replacement inode is not the receipt we saved.
        reopened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                           dir_fd=tx.parent)
        try:
            keys = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
                    'st_size', 'st_mtime_ns', 'st_ctime_ns')
            expected = tuple(getattr(written, key) for key in keys)
            observed = (os.fstat(stream.fileno()), os.fstat(reopened),
                        os.stat(name, dir_fd=tx.parent, follow_symlinks=False))
            if (written.st_size != len(raw)
                    or any(tuple(getattr(item, key) for key in keys) != expected
                           for item in observed)):
                raise control.ControlError('SEC014_ACTOR_RECEIPT_CHANGED')
            tx.check()
        finally:
            os.close(reopened)
    return hashlib.sha256(raw).hexdigest()


def prepared_phase_receipt(tx, image, terminal, host_parent_proof):
    """Trusted executor input only; terminal producer/host authority remain separate."""
    name = f"sec014-{tx.value['direction']}-{tx.value['actorPid']}-{tx.value['actorStartTicks']}-prepare"
    argv = ['/usr/bin/docker', 'compose', '--env-file', '/dev/null', '-f',
            '/home/kite/BellTeam/compose.state-prepare.yaml', 'run', '--no-deps',
            '--name', name, '-T', 'state-prepare']
    if (type(image) is not str or not re.fullmatch(
            r'ghcr\.io/kitepon/bellteam-server@sha256:[a-f0-9]{64}', image)
            or type(host_parent_proof) is not str
            or not re.fullmatch('[a-f0-9]{64}', host_parent_proof)
            or type(terminal) is not dict
            or set(terminal) != {'schema', 'direction', 'image', 'actorPid',
                'actorStartTicks', 'clientPid', 'clientStartTicks', 'containerId',
                'containerName', 'argv', 'status', 'exitCode', 'unknown'}
            or terminal['schema'] != 'bellteam.sec014.prepare-terminal.v1'
            or terminal['direction'] != tx.value['direction']
            or terminal['image'] != image
            or any(type(terminal[key]) is not int or terminal[key] != tx.value[key]
                   for key in ('actorPid', 'actorStartTicks'))
            or any(type(terminal[key]) is not int or terminal[key] <= 0
                   for key in ('clientPid', 'clientStartTicks'))
            or type(terminal['containerId']) is not str
            or not re.fullmatch('[a-f0-9]{64}', terminal['containerId'])
            or terminal['containerName'] != name or terminal['argv'] != argv
            or terminal['status'] != 'exited' or type(terminal['exitCode']) is not int
            or terminal['exitCode'] != 0 or terminal['unknown'] is not False):
        raise control.ControlError('SEC014_PREPARE_TERMINAL_UNCONFIRMED')
    tx.check()
    metadata = prepared.read_prepared_proof()
    tx.check()
    # Retain exact metadata bytes, not only a reference to a transient return value.
    artifact = {'schema': 'bellteam.sec014.prepare-evidence.v1',
                'terminal': terminal, 'metadataUtf8': metadata.decode('utf-8'),
                'metadataSha256': hashlib.sha256(metadata).hexdigest()}
    evidence_sha = _save_json(tx, tx.value['direction'] + '-prepare-evidence.json', artifact)
    return {'schema': 'bellteam.sec014.phase-receipt.v1',
            'direction': tx.value['direction'], 'phase': 'prepared', 'image': image,
            'actorPid': tx.value['actorPid'], 'actorStartTicks': tx.value['actorStartTicks'],
            'status': 'verified', 'proofs': {'host_parents': host_parent_proof,
                                           'six_prepared_leaves': evidence_sha}}


def _run(tx, image, executor):
    """Internal executor owns real verification; no arbitrary command/argv input."""
    if type(image) is not str or not re.fullmatch(
            r'ghcr\.io/kitepon/bellteam-server@sha256:[a-f0-9]{64}', image):
        raise control.ControlError('SEC014_ACTOR_IMAGE')
    results = []
    methods = (executor.prepare, executor.assert_writers_stopped,
               executor.backup_and_migrate, executor.assert_binds,
               executor.start_selected_normal, executor.verify_result)
    for phase, required, method in zip(control.PHASES, PROOFS, methods):
        tx.check()
        # Both aliases remain stopped until both backups, migration and binds pass.
        receipt = method(direction=tx.value['direction'], image=image,
                         actor_pid=tx.value['actorPid'],
                         actor_start_ticks=tx.value['actorStartTicks'])
        sha = _receipt(tx, phase, image, receipt, required)
        tx.confirmed(phase)
        results.append({'phase': phase, 'receiptSha256': sha})
    return results


def run_actor(direction, image, executor):
    with control.host_control(direction) as tx:
        return _run(tx, image, executor)
