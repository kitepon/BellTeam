#!/usr/bin/python3 -I
"""Fixed private-volume SCE maintenance entry; paths and values never use argv."""

import fcntl
import os
import re
import secrets
import stat
import sys
from urllib.parse import urlsplit


CONTROL = '/srv/bellteam-private'
DIRECTORY = CONTROL + '/state/bughub'
SERVER_UID = 1001
SERVER_GID = 1001
MAX_INPUT = 8192
HEADER = re.compile(rb'x-bughub-security-token: [\x21-\x7e]+\r?\n\Z')


class InstallError(Exception):
    pass


def read_input(stream, mode='headers'):
    # One complete header line. A cut-off line, extra headers (including an
    # actor), blank input and oversized input never reach the commit step.
    value = stream.read(MAX_INPUT + 1)
    if not isinstance(value, bytes) or len(value) > MAX_INPUT:
        raise InstallError('SCE_INSTALL_INPUT_INVALID')
    if mode == 'headers':
        valid = HEADER.fullmatch(value)
    elif mode == 'endpoint':
        valid = re.fullmatch(rb'https?://[\x21-\x7e]+\r?\n', value)
        if valid:
            try:
                address = value.rstrip(b'\r\n').decode('ascii')
                url = urlsplit(address)
                host = url.hostname
                valid = (host and not url.username and not url.password
                         and '@' not in url.netloc and '\\' not in url.netloc
                         and '%' not in url.netloc and not url.query and not url.fragment
                         and '?' not in address and '#' not in address
                         and url.path == '/api/security/v1'
                         and (url.port is None or 1 <= url.port <= 65535))
                if valid and ':' not in host:
                    valid = (len(host) <= 253 and all(re.fullmatch(
                        r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?', label)
                        for label in host.rstrip('.').split('.')))
            except ValueError:
                valid = False
    else:
        valid = False
    if not valid:
        raise InstallError('SCE_INSTALL_INPUT_INVALID')
    return value


def open_directory(path):
    # Do not follow a symlink in any component, including the fixed parent.
    if not os.path.isabs(path):
        raise InstallError('SCE_INSTALL_DIRECTORY_INVALID')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.split('/'):
            if not component:
                continue
            if component in ('.', '..'):
                raise InstallError('SCE_INSTALL_DIRECTORY_INVALID')
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def install(stream, directory=DIRECTORY, *, mode='headers', server_uid=SERVER_UID,
            server_gid=SERVER_GID, directory_uid=SERVER_UID):
    """Replace one fixed leaf, with no output or reads of the old file.

    Keyword parameters support synthetic filesystem tests. The privileged CLI
    never accepts overrides and always uses the fixed constants above.
    All input/write/chown/fsync failures before rename retain the live file.
    Rename is the commit point; power-loss durability of the directory entry
    is not asserted here. Backup/latest-generation rollback is a separate step.
    """
    value = read_input(stream, mode)
    try:
        descriptor = open_directory(directory)
    except FileNotFoundError:
        parent = open_directory(os.path.dirname(directory))
        created = False
        try:
            try:
                os.mkdir(os.path.basename(directory), 0o700, dir_fd=parent)
                created = True
            except FileExistsError:
                pass
            descriptor = os.open(os.path.basename(directory),
                                 os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            if created:
                try:
                    os.fchown(descriptor, directory_uid, server_gid)
                    os.fchmod(descriptor, 0o711)
                except BaseException:
                    os.close(descriptor)
                    raise
        finally:
            os.close(parent)
    temporary = None
    output = None
    try:
        parent = os.fstat(descriptor)
        if (parent.st_uid != directory_uid or parent.st_gid != server_gid
                or stat.S_IMODE(parent.st_mode) != 0o711):
            raise InstallError('SCE_INSTALL_DIRECTORY_INVALID')
        try:
            current = os.stat(mode, dir_fd=descriptor, follow_symlinks=False)
        except FileNotFoundError:
            current = None
        if current is not None and (not stat.S_ISREG(current.st_mode) or current.st_nlink != 1
                or current.st_uid != server_uid or current.st_gid != server_gid
                or stat.S_IMODE(current.st_mode) != 0o600):
            raise InstallError('SCE_INSTALL_CURRENT_INVALID')
        candidate = '.' + mode + '-' + secrets.token_hex(16) + '.tmp'
        output = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=descriptor)
        temporary = candidate
        os.fchmod(output, 0o600)
        view = memoryview(value)
        while view:
            count = os.write(output, view)
            if count <= 0:
                raise InstallError('SCE_INSTALL_WRITE_FAILED')
            view = view[count:]
        os.fchown(output, server_uid, server_gid)
        os.fsync(output)
        os.close(output)
        output = None
        os.replace(temporary, mode, src_dir_fd=descriptor, dst_dir_fd=descriptor)
        temporary = None
    finally:
        try:
            if output is not None:
                os.close(output)
        finally:
            try:
                if temporary is not None:
                    os.unlink(temporary, dir_fd=descriptor)
            finally:
                os.close(descriptor)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('headers', 'endpoint'):
        sys.stderr.write('SCE_INSTALL_ARGUMENTS_FORBIDDEN\n')
        return 2
    if os.geteuid() != 0:
        sys.stderr.write('SCE_INSTALL_ROOT_REQUIRED\n')
        return 2
    try:
        descriptor = open_directory(CONTROL)
        try:
            info = os.fstat(descriptor)
            if (info.st_uid != 0 or info.st_gid != SERVER_GID
                    or stat.S_IMODE(info.st_mode) != 0o750):
                raise InstallError('SCE_INSTALL_DIRECTORY_INVALID')
            try:
                fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                sys.stderr.write('SCE_INSTALL_BUSY\n')
                return 75
            linked = os.stat(CONTROL, follow_symlinks=False)
            if ((linked.st_dev, linked.st_ino, linked.st_uid, linked.st_gid, linked.st_mode)
                    != (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode)):
                raise InstallError('SCE_INSTALL_DIRECTORY_INVALID')
            install(sys.stdin.buffer, directory=DIRECTORY, mode=sys.argv[1])
        finally:
            os.close(descriptor)
    except InstallError as error:
        sys.stderr.write(str(error) + '\n')
        return 1
    except (OSError, EOFError):
        # Never print paths, input, exceptions with payloads, or content hashes.
        sys.stderr.write('SCE_INSTALL_IO_ERROR\n')
        return 1
    except KeyboardInterrupt:
        sys.stderr.write('SCE_INSTALL_INTERRUPTED\n')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
