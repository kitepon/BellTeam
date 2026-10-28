"""Ordinary-FS C/Node tests with path/identity substitutions, never real UID1001."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import select
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
BEFORE = os.environ.get('SEC014_ENTRY_BEFORE')
TOKEN = 'a' * 64
PHASES = ['writers_stopped', 'prepared', 'migrated', 'binds_confirmed', 'started', 'verified']


class NormalEntry(unittest.TestCase):
    def setUp(self):
        if os.getuid() != os.getgid(): self.skipTest('test identity substitution requires equal UID/GID')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.control = self.root / 'control'
        self.control.mkdir(mode=0o750)
        self.control.chmod(0o750)
        self.lock = self.control / 'sec014.lock'
        self.lock.write_text('to-server\n')
        self.lock.chmod(0o640)
        self.marker = self.root / 'bootstrap.json'
        self.app = self.root / 'app'
        self.app.mkdir()
        code = self.source('src/supervisor.mjs', 'supervisor.mjs')
        code = code.replace('=== 1001', '=== ' + str(os.getuid()))
        code = code.replace('value.uid !== 0', 'value.uid !== ' + str(os.getuid()))
        code = code.replace('value.gid !== 1001', 'value.gid !== ' + str(os.getgid()))
        code = code.replace('/run/bellteam-maintenance', str(self.control))
        (self.app / 'supervisor.mjs').write_text(code)
        (self.app / 'legacy-supervisor.mjs').write_text(self.source('src/supervisor.mjs', 'supervisor.mjs'))
        (self.app / 'runtime-home.mjs').write_text(self.source('src/runtime-home.mjs', 'runtime-home.mjs'))
        (self.app / 'bootstrap.mjs').write_text('''
import {writeFileSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {runtimeEnvironment} from './runtime-home.mjs';
const lock=statSync(process.env.SYNTHETIC_LOCK);
const script=`const fs=require('node:fs');let n=0;for(const f of fs.readdirSync('/proc/self/fd')){try{const s=fs.fstatSync(+f);if(s.dev===${lock.dev}&&s.ino===${lock.ino})n++}catch{}};console.log(n)`;
const child=spawnSync(process.execPath,['-e',script],{stdio:['ignore','pipe','pipe'],encoding:'utf8'});
const env=runtimeEnvironment({BELLTEAM_HOME:'/synthetic',BELLTEAM_NORMAL_ADMISSION_TOKEN:'synthetic'});
writeFileSync(process.env.SYNTHETIC_MARKER,JSON.stringify({token:process.env.BELLTEAM_NORMAL_ADMISSION_TOKEN??null,childLockFDs:Number(child.stdout.trim()),runtimeToken:env.BELLTEAM_NORMAL_ADMISSION_TOKEN??null}));
''')
        (self.app / 'application-runtime.mjs').write_text('export async function createApplicationRuntime(){return {async start(){},async close(){}}}\n')
        shutil.copyfile(ROOT / 'src/lifecycle.mjs', self.app / 'lifecycle.mjs')
        code = self.source('scripts/server-start.c', 'server-start.c')
        code = code.replace('1001', str(os.getuid())).replace('st_uid != 0', 'st_uid != ' + str(os.getuid()))
        code = code.replace('/run/bellteam-maintenance', str(self.control))
        code = code.replace('/app/src/supervisor.mjs', str(self.app / 'supervisor.mjs'))
        code = code.replace('chdir("/app")', 'chdir(' + json.dumps(str(self.app)) + ')')
        (self.root / 'server.c').write_text(code)
        self.entry = self.root / 'server'
        subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', str(self.root / 'server.c'), '-o', str(self.entry)], check=True, capture_output=True)
        self.journal()

    def source(self, path, before_name):
        return (Path(BEFORE) / before_name if BEFORE else ROOT / path).read_text()

    def journal(self, **changes):
        value = dict(schema='bellteam.sec014.host-transaction.v1', direction='to-server',
            status='incomplete', actorPid=os.getpid(), actorStartTicks=1, phases=PHASES[:4],
            admission={'containerId': 'b' * 64, 'image': 'sha256:' + 'c' * 64, 'token': TOKEN},
            normal={'path': '/synthetic/.bellteam-compose.aaaaaa/normal.json'})
        value.update(changes)
        path = self.control / 'transaction-to-server.json'
        path.write_text(json.dumps(value)); path.chmod(0o640)

    def start(self, token=TOKEN, bare=False):
        self.marker.unlink(missing_ok=True)
        env = {**os.environ, 'BELLTEAM_NORMAL_ADMISSION_TOKEN': token,
               'SYNTHETIC_MARKER': str(self.marker), 'SYNTHETIC_LOCK': str(self.lock)}
        args = [shutil.which('node'), str(self.app / 'supervisor.mjs')] if bare else [str(self.entry)]
        child = subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def finish():
            if child.poll() is None: child.terminate()
            child.communicate(timeout=5)
        self.addCleanup(finish)
        return child

    def observed(self, child):
        end = time.monotonic() + 4
        while time.monotonic() < end and child.poll() is None and not self.marker.exists(): time.sleep(.01)
        if child.poll() is None and self.marker.exists():
            self.assertTrue(select.select([child.stderr], [], [], 4)[0], 'normal did not reach ready')
            self.assertEqual(child.stderr.readline(), b'BellTeam ready\n')

    def refused(self, child):
        self.observed(child)
        if child.poll() is None: child.terminate()
        _, stderr = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 126, stderr.decode())
        self.assertFalse(self.marker.exists(), 'bootstrap imported before admission')

    def test_exclusive_writer_blocks_all_bootstrap_imports(self):
        with self.lock.open('r') as writer:
            fcntl.flock(writer, fcntl.LOCK_EX)
            self.refused(self.start())

    def test_unpublished_archiving_wrong_selection_and_incomplete_phase_refuse(self):
        for selector, token, phases in [('archiving\n', TOKEN, PHASES[:4]),
                ('to-server\n', '', PHASES[:4]), ('to-server\n', 'd' * 64, PHASES[:4]),
                ('to-server\n', TOKEN, PHASES[:3])]:
            with self.subTest(selector=selector, tokenLength=len(token), phases=len(phases)):
                self.lock.write_text(selector); self.journal(phases=phases)
                self.refused(self.start(token))

    def test_shared_lifetime_survives_root_release_and_does_not_leak_to_spawn(self):
        for count in (4, 5, 6):
            self.journal(phases=PHASES[:count], status='completed' if count == 6 else 'incomplete')
            with self.subTest(phases=count):
                root = self.lock.open('r')
                self.addCleanup(root.close)
                fcntl.flock(root, fcntl.LOCK_SH)
                child = self.start(); self.observed(child)
                self.assertTrue(self.marker.exists(), child.stderr.read() if child.poll() is not None else 'not started')
                seen = json.loads(self.marker.read_text())
                self.assertIsNone(seen['token'])
                self.assertIsNone(seen['runtimeToken'])
                self.assertEqual(seen['childLockFDs'], 0)
                fcntl.flock(root, fcntl.LOCK_UN)
                with self.lock.open('r') as next_actor:
                    with self.assertRaises(BlockingIOError): fcntl.flock(next_actor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    child.terminate(); child.communicate(timeout=5)
                    self.assertEqual(child.returncode, 0)
                    fcntl.flock(next_actor, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_wrong_metadata_and_symlink_lock_refuse_before_import(self):
        self.lock.chmod(0o644)
        self.refused(self.start())
        self.lock.chmod(0o640)
        original = self.control / 'original'
        self.lock.rename(original); self.lock.symlink_to(original)
        self.refused(self.start())

    def test_bare_node_has_no_c_owned_shared_lock(self):
        self.refused(self.start(bare=True))

    def test_legacy_nonserver_supervisor_still_starts_without_admission(self):
        if os.getuid() == 1001: self.skipTest('legacy case needs a nonserver test user')
        self.marker.unlink(missing_ok=True)
        child = subprocess.Popen([shutil.which('node'), str(self.app / 'legacy-supervisor.mjs')],
            env={**os.environ, 'SYNTHETIC_MARKER': str(self.marker), 'SYNTHETIC_LOCK': str(self.lock)},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.observed(child)
            self.assertTrue(self.marker.exists())
        finally:
            if child.poll() is None: child.terminate()
            child.communicate(timeout=5)
        self.assertEqual(child.returncode, 0)

    def test_seat_entry_closes_inherited_lock_without_privileged_identity_changes(self):
        source = self.root / 'seat.c'
        source.write_text(self.source('scripts/seat-exec.c', 'seat-exec.c'))
        shim = self.root / 'identity-shim.c'
        shim.write_text('''#include <unistd.h>
#include <grp.h>
uid_t __wrap_geteuid(void){return 0;}
int __wrap_setgroups(size_t n,const gid_t *p){(void)n;(void)p;return 0;}
int __wrap_setresgid(gid_t a,gid_t b,gid_t c){(void)a;(void)b;(void)c;return 0;}
int __wrap_setresuid(uid_t a,uid_t b,uid_t c){(void)a;(void)b;(void)c;return 0;}
int __wrap_getresuid(uid_t *a,uid_t *b,uid_t *c){*a=*b=*c=1000;return 0;}
int __wrap_getresgid(gid_t *a,gid_t *b,gid_t *c){*a=*b=*c=1000;return 0;}
int __wrap_getgroups(int n,gid_t *p){(void)n;(void)p;return 0;}
int __wrap_prctl(int option,...){(void)option;return 0;}
''')
        entry = self.root / 'seat'
        names = ('geteuid', 'setgroups', 'setresgid', 'setresuid', 'getresuid', 'getresgid', 'getgroups', 'prctl')
        subprocess.run(['cc', '-O2', '-Wall', '-Wextra', '-Werror', str(source), str(shim),
            *['-Wl,--wrap=' + x for x in names], '-o', str(entry)], check=True, capture_output=True)
        with self.lock.open('r') as held:
            fcntl.flock(held, fcntl.LOCK_SH)
            value = os.fstat(held.fileno())
            script = "import os,json; matches=[]\nfor f in os.listdir('/proc/self/fd'):\n try:\n  s=os.fstat(int(f))\n  if (s.st_dev,s.st_ino)==(%d,%d): matches.append(f)\n except OSError: pass\nprint(json.dumps(matches))" % (value.st_dev, value.st_ino)
            run = subprocess.run([str(entry), '--', sys.executable, '-I', '-c', script],
                pass_fds=(held.fileno(),), capture_output=True, text=True, timeout=5)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads(run.stdout), [])


if __name__ == '__main__': unittest.main()
