"""Read only preparation metadata; no Docker, CLI or host authority claim."""
import importlib.util
import json
import os
from pathlib import Path
import stat

_spec = importlib.util.spec_from_file_location(
    'sec014_proof_control', Path(__file__).with_name('sec014-host-control.py'))
control = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(control)
LEAVES = ('state', 'rooms', 'owner', 'logs', 'bellteam-settings', 'apns')
KEYS = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
        'st_size', 'st_mtime_ns', 'st_ctime_ns')


def _same(before, after):
    if any(getattr(before, key) != getattr(after, key) for key in KEYS):
        raise control.ControlError('SEC014_PREPARED_PROOF_CHANGED')


def _read(parent_path, parent_owner, leaf_owner):
    """Path/owner injection is only for ordinary-filesystem tests."""
    parent = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY
                     | os.O_NOFOLLOW | os.O_CLOEXEC)
    held = []
    try:
        before = os.fstat(parent)
        control._private(before, parent_owner, True)
        _same(before, os.lstat(parent_path))
        if set(os.listdir(parent)) != {*LEAVES, '.prepared.json'}:
            raise control.ControlError('SEC014_PREPARED_PROOF_CONTENTS')
        receipt_stat = os.stat('.prepared.json', dir_fd=parent,
                               follow_symlinks=False)
        saved = control._saved(parent, '.prepared.json', parent_owner)
        identity = {'device': str(before.st_dev), 'inode': str(before.st_ino)}
        if (type(saved) is not dict
                or set(saved) != {'schema', 'parent', 'leaves'}
                or saved['schema'] != 'bellteam.state-directories.v1'
                or saved['parent'] != identity
                or type(saved['leaves']) is not list
                or len(saved['leaves']) != len(LEAVES)):
            raise control.ControlError('SEC014_PREPARED_PROOF_RECEIPT')
        observed = []
        for name, expected in zip(LEAVES, saved['leaves']):
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                         | os.O_CLOEXEC, dir_fd=parent)
            # Register before fstat so its failure still closes the opened FD.
            held.append((name, fd, None))
            info = os.fstat(fd)
            held[-1] = (name, fd, info)
            if (not stat.S_ISDIR(info.st_mode)
                    or (info.st_uid, info.st_gid) != leaf_owner
                    or stat.S_IMODE(info.st_mode) != 0o711
                    or expected != {'name': name, 'device': str(info.st_dev),
                                    'inode': str(info.st_ino)}):
                raise control.ControlError('SEC014_PREPARED_PROOF_LEAF')
            _same(info, os.stat(name, dir_fd=parent, follow_symlinks=False))
            observed.append({**expected, 'uid': info.st_uid,
                             'gid': info.st_gid, 'mode': '0711'})
        # Hold every leaf until the receipt and all linked identities agree.
        for name, fd, info in held:
            _same(info, os.fstat(fd))
            _same(info, os.stat(name, dir_fd=parent, follow_symlinks=False))
        _same(receipt_stat, os.stat('.prepared.json', dir_fd=parent,
                                    follow_symlinks=False))
        _same(before, os.fstat(parent))
        _same(before, os.lstat(parent_path))
        return json.dumps({'schema': 'bellteam.sec014.prepared-proof.v1',
                           'parent': identity, 'leaves': observed},
                          sort_keys=True, allow_nan=False).encode()
    finally:
        for _, fd, _ in held:
            os.close(fd)
        os.close(parent)


def read_prepared_proof():
    if any(value != 0 for value in
           (os.getuid(), os.geteuid(), os.getgid(), os.getegid())):
        raise control.ControlError('SEC014_PREPARED_PROOF_ROOT_REQUIRED')
    return _read(control.CONTROL.parent/'state-data', (0, 0), (1001, 1001))
