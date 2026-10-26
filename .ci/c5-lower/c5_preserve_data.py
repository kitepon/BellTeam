"""Offline deployment evidence: hashes/prefixes and DB paths, never file contents."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import sys


def file_hash(path, length, expected, append_allowed):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):
            raise ValueError('file replaced during read: ' + str(path))
        while length:
            chunk = stream.read(min(length, 1024 * 1024))
            if not chunk:
                raise ValueError('file shortened during read: ' + str(path))
            digest.update(chunk)
            length -= len(chunk)
        if not append_allowed and os.fstat(stream.fileno()).st_mtime_ns != expected.st_mtime_ns:
            raise ValueError('configuration changed during read: ' + str(path))
    return digest.hexdigest()


def capture(root, before=None):
    root = Path(root).resolve()
    patterns = {
        'config': ['owner/profile.json', 'owner/user-rules.md',
                   'shared/tools/bellteam-settings/settings.json',
                   'shared/ai-control.json', 'shared/subscription.json',
                   'bots/*/bot.json', 'rooms/*/room.json'],
        'history': ['logs/direct-messages.jsonl', 'rooms/*/messages.jsonl'],
        'databasePaths': ['bots/*/memory/memory.db', 'bots/*/rag/index.db',
                          'shared/memory/memory.db', 'shared/rag/index.db'],
    }
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'root': str(root), 'config': {}, 'history': {}, 'databasePaths': {}}
    for group, globs in patterns.items():
        for pattern in globs:
            for path in sorted(root.glob(pattern)):
                if path.is_symlink() or not path.resolve().is_relative_to(root):
                    raise ValueError('unexpected linked evidence path: ' + str(path))
                stat = path.stat()
                name = str(path.relative_to(root))
                entry = {'bytes': stat.st_size, 'device': stat.st_dev, 'inode': stat.st_ino}
                if group != 'databasePaths':
                    length = stat.st_size
                    if before and group == 'history' and name in before[group]:
                        length = before[group][name]['bytes']
                    entry['hashedBytes'] = length
                    entry['sha256'] = file_hash(path, length, stat, group == 'history')
                result[group][name] = entry
    if before:
        changes = []
        for group in patterns:
            for name, old in before[group].items():
                new = result[group].get(name)
                if new is None:
                    changes.append({'group': group, 'path': name, 'change': 'missing'})
                elif group != 'databasePaths' and old['sha256'] != new['sha256']:
                    changes.append({'group': group, 'path': name, 'change': 'bytes_changed'})
                elif group == 'databasePaths' and (old['device'], old['inode']) != (new['device'], new['inode']):
                    changes.append({'group': group, 'path': name, 'change': 'identity_changed'})
            for name in result[group].keys() - before[group].keys():
                changes.append({'group': group, 'path': name, 'change': 'added'})
        result['comparison'] = changes
    return result


if __name__ == '__main__':
    baseline = json.loads(Path(sys.argv[2]).read_text()) if len(sys.argv) > 2 else None
    print(json.dumps(capture(sys.argv[1], baseline), indent=2))
