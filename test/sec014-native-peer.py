import importlib.util
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_peer_control', ROOT/'distribution/internal/sec014-host-control.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class NativePeer(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sec014-peer-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.control = self.root/'control'
        self.control.mkdir(mode=0o700)
        self.path = self.root/'docker.sock'

    def listener(self, executable=sys.executable):
        program = "import socket,sys,os; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(8); print('ready',flush=True); sys.stdin.buffer.read(1); os.execv('/usr/bin/sleep',['sleep','30'])"
        p = subprocess.Popen([executable, '-c', program, str(self.path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
        def cleanup():
            if p.poll() is None:
                p.terminate()
            p.wait(timeout=2)
            for stream in (p.stdin, p.stdout, p.stderr):
                stream.close()
        self.addCleanup(cleanup)
        self.assertEqual(p.stdout.readline(), b'ready\n')
        return p

    def test_real_kernel_peer_is_bound_to_endpoint(self):
        p = self.listener()
        with c._hold(self.control, 'to-server', (os.getuid(), os.getgid())) as tx, \
                patch.object(type(tx), '_docker_socket_path', self.path):
            value = tx._docker_endpoint()
            self.assertEqual(value['peer']['pid'], p.pid)
            self.assertEqual((value['peer']['uid'], value['peer']['gid']), (os.getuid(), os.getgid()))
            self.assertEqual(value['peer']['process']['executable']['path'], os.path.realpath(sys.executable))
            self.assertGreater(value['peer']['process']['startTicks'], 0)
            self.assertFalse(value['hostAuthority'])
            tx.check()
            self.assertEqual(tx._docker_endpoint(), value)

    def test_bound_path_without_listener_cannot_start_native_clients(self):
        with socket.socket(socket.AF_UNIX) as s:
            s.bind(str(self.path))
            with c._hold(self.control, 'to-server', (os.getuid(), os.getgid())) as tx, \
                    patch.object(type(tx), '_docker_socket_path', self.path):
                with self.assertRaises((ConnectionRefusedError, c.ControlError)):
                    tx._docker_endpoint()

    def test_seat_owned_executable_cannot_be_accepted_as_daemon(self):
        executable = self.root/'python-listener'
        shutil.copyfile(sys.executable, executable)
        executable.chmod(0o755)
        self.listener(str(executable))
        with c._hold(self.control, 'to-server', (os.getuid(), os.getgid())) as tx, \
                patch.object(type(tx), '_docker_socket_path', self.path):
            with self.assertRaisesRegex(c.ControlError, 'PEER_EXECUTABLE'):
                tx._docker_endpoint()

    def test_peer_exit_refuses_existing_transaction(self):
        p = self.listener()
        with c._hold(self.control, 'to-server', (os.getuid(), os.getgid())) as tx, \
                patch.object(type(tx), '_docker_socket_path', self.path):
            tx._docker_endpoint()
            p.terminate()
            p.wait(timeout=2)
            with self.assertRaisesRegex(c.ControlError, 'PEER_UNCONFIRMED'):
                tx.check()

    def test_same_pid_exec_change_refuses_existing_transaction(self):
        p = self.listener()
        with c._hold(self.control, 'to-server', (os.getuid(), os.getgid())) as tx, \
                patch.object(type(tx), '_docker_socket_path', self.path):
            tx._docker_endpoint()
            p.stdin.write(b'x')
            p.stdin.flush()
            end = time.monotonic()+2
            while os.readlink(f'/proc/{p.pid}/exe') != '/usr/bin/sleep':
                if time.monotonic() >= end:
                    self.fail('fixture exec did not complete')
                time.sleep(.001)
            with self.assertRaisesRegex(c.ControlError, 'PEER'):
                tx.check()


if __name__ == '__main__':
    unittest.main()
