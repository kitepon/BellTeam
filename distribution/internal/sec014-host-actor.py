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
    raw = json.dumps(value, sort_keys=True, allow_nan=False).encode()
    tx.check()
    name = tx.value['direction'] + '-' + phase + '.receipt.json'
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
