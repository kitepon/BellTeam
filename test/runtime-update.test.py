#!/usr/bin/env python3
"""Z-b2 P4/P5 contract: four fixed targets, safe closure staging, serialized next-launch selection."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import runtime_update as ru

PLATFORM = {'os': 'linux', 'arch': 'amd64', 'libc': 'glibc', 'nodeMajor': 26}
SOURCE, SIGNER = 'a' * 40, 'b' * 40


def build(component, files, links=(), extra=()):
    """files: {relpath: bytes}, links: [(relpath, target)] -> (archive path, receipt, expected)"""
    entries = [{'path': p, 'type': 'file', 'bytes': len(b), 'sha256': hashlib.sha256(b).hexdigest(),
                'mode': 0o555 if p.startswith('prefix/bin/') else 0o444} for p, b in files.items()]
    entries += [{'path': p, 'type': 'symlink', 'target': t} for p, t in links]
    manifest = {'schema': ru.ARTIFACT_SCHEMA, 'component': component, 'package': ru.COMPONENTS[component]['package'],
                'upstreamVersion': '1.2.3', 'sourceCommit': SOURCE, 'platform': PLATFORM, 'files': entries}
    raw = json.dumps(manifest).encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        def add(name, data):
            info = tarfile.TarInfo(name); info.size = len(data); tar.addfile(info, io.BytesIO(data))
        add('manifest.json', raw)
        for p, b in files.items(): add(p, b)
        for p, t in links:
            info = tarfile.TarInfo(p); info.type = tarfile.SYMTYPE; info.linkname = t; tar.addfile(info)
        for p, b in extra: add(p, b)
    data = buffer.getvalue()
    handle = tempfile.NamedTemporaryFile(delete=False, suffix='.tar.gz'); handle.write(data); handle.close()
    sha = hashlib.sha256(data).hexdigest()
    receipt = {'schema': 'bellteam.runtime.verification.v1', 'component': component, 'archiveSha256': sha,
               'manifestSha256': hashlib.sha256(raw).hexdigest(), 'manifest': manifest,
               'verification': {'method': 'github-oidc-attestation', 'repositoryId': '1404510084'}}
    return handle.name, receipt, {'archiveSha256': sha, 'sourceCommit': SOURCE, 'signerCommit': SIGNER}


def codex(version=b'v1'):
    return build('runtime-codex', {'prefix/lib/node_modules/@openai/codex/bin/codex.js': version},
                 links=[('prefix/bin/codex', '../lib/node_modules/@openai/codex/bin/codex.js')])


class RuntimeUpdate(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def test_four_fixed_targets_and_cross_target_rejection(self):
        self.assertEqual(set(ru.COMPONENTS), {'runtime-aiterm-mcp', 'runtime-codex', 'runtime-claude-code', 'runtime-throughline'})
        archive, receipt, expected = codex()
        with self.assertRaises(ru.RuntimeFailure):
            ru.stage(self.root, 'runtime-claude-code', archive, receipt, expected, PLATFORM)
        with self.assertRaises(ru.RuntimeFailure):
            ru.stage(self.root, 'runtime-npm-anything', archive, receipt, expected, PLATFORM)
        with self.assertRaises(ru.RuntimeFailure) as abi:
            ru.stage(self.root, 'runtime-codex', archive, receipt, expected, {**PLATFORM, 'arch': 'arm64'})
        self.assertEqual(abi.exception.code, 'RUNTIME_ABI_INCOMPATIBLE')

    def test_unsafe_members_are_rejected(self):
        cases = [
            build('runtime-codex', {'prefix/bin/codex': b'x'}, links=[('prefix/lib/evil', '../../../etc')]),
            build('runtime-codex', {'prefix/bin/codex': b'x'}, links=[('prefix/lib/abs', '/etc/passwd')]),
            # write-through-link escape: a/b/c -> prefix root, then a/b/c/d -> ../../.. would leave it
            build('runtime-codex', {'prefix/bin/codex': b'x'}, links=[('prefix/a/b/c', '../..'), ('prefix/a/b/c/d', '../../..')]),
            build('runtime-codex', {'prefix/bin/codex': b'x'}, extra=[('prefix/unlisted', b'y')]),
            build('runtime-codex', {'prefix/lib/x.js': b'x'}),  # missing fixed bin entry
        ]
        for archive, receipt, expected in cases:
            with self.assertRaises(ru.RuntimeFailure):
                ru.stage(self.root, 'runtime-codex', archive, receipt, expected, PLATFORM)
        self.assertEqual([p for p in (self.root / 'packages' / 'runtime-codex').iterdir()], [])

    def test_stage_is_immutable_and_reusable(self):
        archive, receipt, expected = codex()
        closure = ru.stage(self.root, 'runtime-codex', archive, receipt, expected, PLATFORM)
        self.assertEqual(os.readlink(closure / 'prefix/bin/codex'), '../lib/node_modules/@openai/codex/bin/codex.js')
        self.assertEqual((closure / 'prefix/bin/codex').read_bytes(), b'v1')
        self.assertEqual(ru.stage(self.root, 'runtime-codex', archive, receipt, expected, PLATFORM), closure)

    def test_commit_selects_next_launch_and_serializes(self):
        self.assertEqual(ru.read_current(self.root), (None, {}))  # builtin until a selection exists
        first = ru.stage(self.root, 'runtime-codex', *codex(b'v1')[0:3], PLATFORM)
        generation = ru.commit(self.root, 'runtime-codex', first, 'job-1', None)
        self.assertEqual(ru.read_current(self.root)[0], generation)
        second = ru.stage(self.root, 'runtime-codex', *codex(b'v2')[0:3], PLATFORM)
        # Stale expected generation never overwrites a newer selection.
        with self.assertRaises(ru.RuntimeFailure) as stale:
            ru.commit(self.root, 'runtime-codex', second, 'job-2', None)
        self.assertEqual(stale.exception.code, 'RUNTIME_SELECTION_CHANGED')
        results = []
        def race():
            try: results.append(ru.commit(self.root, 'runtime-codex', second, 'job-2', generation))
            except ru.RuntimeFailure as error: results.append(error.code)
        threads = [threading.Thread(target=race) for _ in range(2)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(sorted(map(len, results)), [len('RUNTIME_SELECTION_CHANGED'), 64])
        current, vector = ru.read_current(self.root)
        self.assertNotEqual(current, generation)
        self.assertEqual(set(vector), {'runtime-codex'})
        self.assertTrue(first.is_dir())  # previous closure stays on disk for running launches
        # Worker loss in swapping: ready only when current already names the target.
        self.assertEqual(ru.recover(self.root, current), 'ready')
        self.assertEqual(ru.recover(self.root, generation), 'failed')


if __name__ == '__main__':
    unittest.main()
