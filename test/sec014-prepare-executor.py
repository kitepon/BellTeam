import hashlib
import errno
from contextlib import contextmanager
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import struct
import sys
import time
from types import SimpleNamespace
from datetime import datetime,timedelta,timezone
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('prepare_executor',ROOT/'distribution/internal/sec014-prepare-executor.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
spec=importlib.util.spec_from_file_location('evidence_fixture',ROOT/'test/sec014-prepare-evidence.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
IMAGE='ghcr.io/kitepon/bellteam-server@sha256:'+'a'*64
IMAGE_ID='sha256:'+'b'*64
CID='c'*64


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.f=fixture.EvidenceTests();self.f.setUp();self.addCleanup(self.f.doCleanups)
        self.commands=[];self.children=[];self.reaped=[];self.values=None
        self.real_popen=subprocess.Popen
        def cleanup():
            for child in self.children:
                subprocess.Popen.wait(child,timeout=1)
                for stream in (child.stdout,child.stderr):
                    if stream: stream.close()
        self.addCleanup(cleanup)
        self.patches=[patch.object(p,'COMPOSE',ROOT/'compose.state-prepare.yaml'),
                      patch.object(p,'PARENT',self.f.state),
                      patch.object(p.actor.prepared,'read_prepared_proof',side_effect=self.f.raw),
                      patch.object(p.subprocess,'Popen',side_effect=self.spawn)]
        for x in self.patches:x.start();self.addCleanup(x.stop)
        self.mutate=lambda value:value
        self.output=None;self.birth=None
        self.socket_path=self.f.state.parent/'docker.sock'
        self.socket=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.addCleanup(self.socket.close)
        self.socket.bind(str(self.socket_path));self.socket_path.chmod(0o660)
        hold=self.f.hold
        self.f.hold=lambda:self.held_image_original(hold())

    @contextmanager
    def held_image_original(self,held):
        with held as tx:
            # Synthetic image input only; the separate Writer integration uses native client evidence.
            output=dict(argv=['/usr/bin/docker','image','inspect','--format','{{json .Id}}',IMAGE],
                        rawUtf8=json.dumps(IMAGE_ID))
            digest=fixture.a._save_json(tx,tx.value['direction']+'-writer-image.output.json',output)
            info=(tx.path/(tx.value['direction']+'-writer-image.output.json')).stat()
            keys=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink',
                  'st_size','st_mtime_ns','st_ctime_ns')
            tx._writer_image_original=dict(output=output,sha256=digest,
                file=dict(sha256=digest,metadata=tuple(getattr(info,key) for key in keys)))
            yield tx

    def inspector(self):
        name=p.actor.prepare_name(self.tx)
        value=dict(id=CID,name='/'+name,imageRef=IMAGE,imageId=IMAGE_ID,
            service='state-prepare',project='bellteam-state-prepare',status='exited',running=False,
            pid=0,exitCode=0,oom=False,user='0:0',ro=True,network='none',
            createdAt=self.birth,startedAt=self.birth,finishedAt=self.birth,restarts=0,init=True,
            entrypoint=['/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','/app/src/server-state-prepare.mjs'],command=None,
            memory=2147483648,swap=2147483648,cpu=1000000000,pids=512,
            caps=['CHOWN'],drop=['ALL'],security=['no-new-privileges:true'],
            tmpfs={'/tmp':'rw,nosuid,nodev,size=64m'},
            mounts=[dict(Type='bind',Source=str(self.f.state),Destination='/srv/bellteam-state-parent',RW=True)])
        return self.mutate(value)

    def spawn(self,argv,**kwargs):
        self.commands.append((argv,kwargs['env']))
        index=len(self.commands)
        if index==1:self.birth=datetime.now(timezone.utc).isoformat()
        raw=[b'{"status":"prepared"}\n',json.dumps(self.inspector()).encode(),CID.encode()+b'\n',b''][index-1]
        err=self.output if self.output and index==1 else b''
        # Fake Docker protocol, actual dedicated Python client only.
        program='import sys;sys.stdout.buffer.write(bytes.fromhex('+repr(raw.hex())+'));sys.stderr.buffer.write(bytes.fromhex('+repr(err.hex())+'))'
        child=self.real_popen([sys.executable,'-c',program],cwd=self.f.root,env=kwargs['env'],
                              stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True)
        self.children.append(child);wait=child.wait
        slot=['run','inspect','remove','absence'][index-1]
        def reap(timeout):
            terminal=self.f.root/f'to-server-prepare-{slot}.terminal.json'
            self.assertTrue(terminal.exists())
            self.assertEqual(json.loads(terminal.read_bytes())['pid'],child.pid)
            self.assertIsNotNone(os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOWAIT|os.WNOHANG))
            self.reaped.append(child.pid)
            return wait(timeout=timeout)
        child.wait=reap
        return child

    def runner(self,host=None,deadline=None):
        endpoint=patch.object(type(self.tx),'_docker_socket_path',self.socket_path,create=True)
        endpoint.start();self.addCleanup(endpoint.stop)
        host = host or (lambda step:'d'*64)
        host.bind_image = lambda image,image_id,image_original:None  # Synthetic authority seam only.
        if not hasattr(host,'invalidate'):host.invalidate=lambda reason:None
        return p._Prepare(self.tx,IMAGE,IMAGE_ID,deadline or time.monotonic()+110,
                          datetime.now(timezone.utc)+timedelta(seconds=120),host)

    def journal(self):
        return json.loads((self.f.root/'transaction-to-server.json').read_bytes())

    def test_image_binding_rejects_inherited_or_changed_actor_before_callback(self):
        calls=[]
        def host(step):return 'd'*64
        host.bind_image=lambda image,image_id,image_original:calls.append((image,image_id))
        host.invalidate=lambda reason:None
        def construct():
            return p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                              datetime.now(timezone.utc)+timedelta(seconds=120),host)
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            read_fd,write_fd=os.pipe()
            pid=os.fork()
            if pid==0:
                os.close(read_fd)
                try:
                    construct()
                    result=dict(error=None,calls=len(calls))
                except Exception as error:
                    result=dict(error=str(error),calls=len(calls))
                try:os.write(write_fd,json.dumps(result).encode())
                finally:os._exit(0)
            os.close(write_fd)
            try:observed=json.loads(os.read(read_fd,1024))
            finally:
                os.close(read_fd)
                _,status=os.waitpid(pid,0)
            self.assertEqual(status,0)
            self.assertEqual(observed,dict(error='SEC014_CONTROL_ACTOR_IDENTITY',calls=0))
            born=self.tx.value['actorStartTicks']
            self.tx.value['actorStartTicks']=born+1
            try:
                with self.assertRaisesRegex(RuntimeError,'ACTOR_IDENTITY'):construct()
                self.assertEqual(calls,[])
            finally:self.tx.value['actorStartTicks']=born
            construct()
            self.assertEqual(calls,[(IMAGE,IMAGE_ID)])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_image_binding_failure_invalidates_and_preserves_original_error(self):
        calls=[];failure=ValueError('partial acquisition')
        def host(step):return 'd'*64
        def bind(image,image_id,image_original):
            calls.append(('bind',image,image_id))
            raise failure
        def invalidate(reason):
            calls.append(('invalidate',reason))
            raise RuntimeError('invalidation also failed')
        host.bind_image,host.invalidate=bind,invalidate
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            with self.assertRaises(ValueError) as caught:
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertIs(caught.exception,failure)
            self.assertEqual(calls,[('bind',IMAGE,IMAGE_ID),('invalidate','UNCONFIRMED_CHILD')])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_image_binding_interrupt_invalidates_and_preserves_original_error(self):
        invalidated=[];failure=KeyboardInterrupt()
        def host(step):return 'd'*64
        def bind(image,image_id,image_original):raise failure
        def invalidate(reason):
            invalidated.append(reason)
            raise KeyboardInterrupt('invalidation also interrupted')
        host.bind_image,host.invalidate=bind,invalidate
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            with self.assertRaises(KeyboardInterrupt) as caught:
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertIs(caught.exception,failure)
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_image_binding_changed_actor_invalidates_before_return(self):
        invalidated=[]
        def host(step):return 'd'*64
        def bind(image,image_id,image_original):self.tx.value['actorStartTicks']+=1
        host.bind_image,host.invalidate=bind,invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            born=self.tx.value['actorStartTicks']
            try:
                with self.assertRaisesRegex(RuntimeError,'ACTOR_IDENTITY'):
                    p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                               datetime.now(timezone.utc)+timedelta(seconds=120),host)
                self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
                self.assertEqual(self.commands,[])
                self.assertEqual(self.journal()['phases'],[])
            finally:self.tx.value['actorStartTicks']=born

    def test_image_binding_missing_invalidator_refuses_before_callback(self):
        calls=[]
        def host(step):return 'd'*64
        host.bind_image=lambda image,image_id,image_original:calls.append((image,image_id))
        with self.f.hold() as self.tx:
            with self.assertRaisesRegex(p.actor.control.ControlError,'HOST_IMAGE_BINDING'):
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertEqual(calls,[])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_socket_original_is_saved_before_binding_and_replacement_refuses(self):
        original=self.socket_path.stat()
        replacement=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.addCleanup(replacement.close)
        seen=[];invalidated=[]
        def host(step):return 'd'*64
        def bind(image,image_id,image_original):
            saved=self.f.root/'to-server-prepare-socket.json'
            seen.append(json.loads(saved.read_bytes()) if saved.exists() else None)
            self.socket_path.rename(self.socket_path.with_name('retained.sock'))
            replacement.bind(str(self.socket_path));self.socket_path.chmod(0o660)
        host.bind_image,host.invalidate=bind,invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            with self.assertRaisesRegex(RuntimeError,'DOCKER_SOCKET_CHANGED'):
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertEqual(len(seen),1)
            self.assertEqual((seen[0]['device'],seen[0]['inode']),
                             (str(original.st_dev),str(original.st_ino)))
            self.assertFalse(seen[0]['hostAuthority'])
            saved=self.f.root/'to-server-prepare-socket.json'
            self.assertEqual(json.loads(saved.read_bytes()),seen[0])
            self.assertEqual(saved.stat().st_mode&0o777,0o600)
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_missing_socket_refuses_before_binding(self):
        self.socket_path.unlink()
        calls=[];invalidated=[]
        def host(step):return 'd'*64
        host.bind_image=lambda image,image_id,image_original:calls.append((image,image_id))
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            with self.assertRaises(FileNotFoundError):
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertEqual(calls,[])
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertFalse((self.f.root/'to-server-prepare-socket.json').exists())
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_socket_original_save_failure_refuses_before_binding(self):
        calls=[];invalidated=[];failure=OSError('synthetic original persistence failure')
        def host(step):return 'd'*64
        host.bind_image=lambda image,image_id,image_original:calls.append((image,image_id))
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path), \
                patch.object(p.actor,'_save_json',side_effect=failure):
            with self.assertRaises(OSError) as caught:
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertIs(caught.exception,failure)
            self.assertEqual(calls,[])
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_native_socket_access_acl_original_reaches_binding(self):
        entries=[(1,6,0xffffffff),(2,4,os.getuid()+1),(4,0,0xffffffff),
                 (16,6,0xffffffff),(32,0,0xffffffff)]
        raw=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in entries)
        os.setxattr(self.socket_path,'system.posix_acl_access',raw,follow_symlinks=False)
        self.assertEqual(os.getxattr(self.socket_path,'system.posix_acl_access',follow_symlinks=False),raw)
        seen=[];invalidated=[]
        def host(step):return 'd'*64
        def bind(image,image_id,image_original):
            saved=json.loads((self.f.root/'to-server-prepare-socket.json').read_bytes())
            seen.append(saved.get('accessAcl'))
        host.bind_image,host.invalidate=bind,invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            runner=p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                              datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertEqual(seen,[dict(rawHex=raw.hex(),errno=None)])
            self.assertEqual(runner.endpoint['accessAcl'],seen[0])
            self.assertFalse(runner.endpoint['hostAuthority'])
            self.tx.check()
            entries[1]=(2,6,os.getuid()+1)
            changed=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in entries)
            os.setxattr(self.socket_path,'system.posix_acl_access',changed,follow_symlinks=False)
            with self.assertRaisesRegex(RuntimeError,'DOCKER_SOCKET_CHANGED'):self.tx.check()
            self.assertEqual(json.loads((self.f.root/'to-server-prepare-socket.json').read_bytes())['accessAcl'],seen[0])
            self.assertEqual(invalidated,[])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def assert_socket_acl_read_failure(self,code):
        calls=[];invalidated=[];failure=OSError(code,'synthetic ACL read unavailable')
        def host(step):return 'd'*64
        host.bind_image=lambda image,image_id,image_original:calls.append((image,image_id))
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path), \
                patch.object(os,'getxattr',side_effect=failure):
            with self.assertRaises(OSError) as caught:
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertIs(caught.exception,failure)
            self.assertEqual(calls,[])
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertFalse((self.f.root/'to-server-prepare-socket.json').exists())
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_socket_acl_read_error_refuses_before_binding(self):
        self.assert_socket_acl_read_failure(errno.EACCES)

    def test_socket_acl_unsupported_refuses_before_binding(self):
        self.assert_socket_acl_read_failure(errno.ENOTSUP)

    def test_oversized_socket_acl_refuses_before_binding(self):
        calls=[];invalidated=[]
        def host(step):return 'd'*64
        host.bind_image=lambda image,image_id,image_original:calls.append((image,image_id))
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path), \
                patch.object(os,'getxattr',return_value=b'x'*4097):
            with self.assertRaisesRegex(RuntimeError,'DOCKER_SOCKET_ACL_LIMIT'):
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertEqual(calls,[])
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertFalse((self.f.root/'to-server-prepare-socket.json').exists())
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_missing_writer_image_original_refuses_before_binding(self):
        calls=[];invalidated=[]
        def host(step):return 'd'*64
        host.bind_image=lambda *values:calls.append(values)
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            self.tx._writer_image_original=None
            with self.assertRaisesRegex(RuntimeError,'WRITER_IMAGE_ORIGINAL'):
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertEqual(calls,[])
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_writer_image_pair_mismatch_refuses_before_binding(self):
        calls=[];invalidated=[]
        def host(step):return 'd'*64
        host.bind_image=lambda *values:calls.append(values)
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            with self.assertRaisesRegex(RuntimeError,'WRITER_IMAGE_ORIGINAL'):
                p._Prepare(self.tx,IMAGE,'sha256:'+'e'*64,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertEqual(calls,[])
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_equal_writer_image_original_replacement_refuses_before_binding(self):
        calls=[];invalidated=[]
        def host(step):return 'd'*64
        host.bind_image=lambda *values:calls.append(values)
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            path=self.f.root/'to-server-writer-image.output.json'
            original=path.read_bytes();inode=path.stat().st_ino
            replacement=path.with_suffix('.replacement');replacement.write_bytes(original)
            replacement.chmod(0o600);replacement.replace(path)
            self.assertEqual(path.read_bytes(),original)
            self.assertNotEqual(path.stat().st_ino,inode)
            with self.assertRaisesRegex(RuntimeError,'WRITER_IMAGE_CHANGED'):
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertEqual(calls,[])
            self.assertEqual(invalidated,[])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_binding_writer_image_original_change_refuses_after_callback(self):
        calls=[];invalidated=[]
        def host(step):return 'd'*64
        def bind(*values):
            calls.append(values[2] if len(values)==3 else None)
            path=self.f.root/'to-server-writer-image.output.json'
            record=json.loads(path.read_bytes());record['rawUtf8']=json.dumps('sha256:'+'e'*64)
            path.write_text(json.dumps(record))
        host.bind_image,host.invalidate=bind,invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            original=self.tx._writer_image_original
            with self.assertRaisesRegex(RuntimeError,'WRITER_IMAGE_CHANGED'):
                p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            self.assertEqual(calls,[original])
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_late_writer_image_original_change_refuses_before_prepare_client(self):
        invalidated=[]
        def host(step):return 'd'*64
        host.bind_image=lambda *values:None
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path):
            runner=p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                              datetime.now(timezone.utc)+timedelta(seconds=120),host)
            original=self.tx._writer_image_original['output']
            path=self.f.root/'to-server-writer-image.output.json'
            record=json.loads(path.read_bytes());record['rawUtf8']=json.dumps('sha256:'+'e'*64)
            path.write_text(json.dumps(record))
            failure=None
            try:runner.prepare()
            except RuntimeError as error:failure=str(error)
            print('WRITER_IMAGE_LATE '+json.dumps(dict(clients=len(self.commands),failure=failure)),flush=True)
            self.assertEqual(failure,'SEC014_PREPARE_PHASE_UNCONFIRMED')
            self.assertEqual(self.commands,[])
            self.assertEqual(self.tx._writer_image_original['output'],original)
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertEqual(self.journal()['phases'],[])

    def test_parent_replacement_at_host_callback_refuses_before_run(self):
        original=self.f.state.stat()
        opened=[];invalidated=[]
        def host(step):
            if step=='run':
                opened.append(getattr(runner,'parent_fd',None))
                if len(opened)==2:
                    self.f.state.rename(self.f.state.with_name('retained-state'))
                    self.f.state.mkdir(mode=0o700)
            return 'd'*64
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx:
            runner=self.runner(host=host)
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):
                runner.prepare()
            self.assertEqual(self.commands,[])
            self.assertTrue(runner.held)
            self.assertEqual(set(invalidated),{'UNCONFIRMED_CHILD'})
            self.assertEqual(len(opened),2)
            self.assertIsNotNone(opened[0])
            self.assertEqual(opened[0],opened[1])
            with self.assertRaises(OSError):os.fstat(opened[0])
            saved=json.loads((self.f.root/'to-server-prepare-parent.json').read_bytes())
            self.assertEqual((saved['device'],saved['inode']),(str(original.st_dev),str(original.st_ino)))
            self.assertFalse(saved['hostAuthority'])
            self.assertEqual(self.journal()['phases'],[])
            self.assertFalse((self.f.root/'to-server-prepare-chain.json').exists())

    def test_nonprivate_parent_refuses_before_host_step_or_client(self):
        self.f.state.chmod(0o755)
        calls=[]
        def host(step):calls.append(step);return 'd'*64
        with self.f.hold() as self.tx:
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):
                self.runner(host=host).prepare()
            self.assertEqual(self.commands,[])
            self.assertEqual(calls,[])
            self.assertEqual(self.journal()['phases'],[])

    def parent_acl_change(self,kind):
        entries=[(1,7,0xffffffff),(2,4,os.getuid()+1),(4,0,0xffffffff),
                 (16,0,0xffffffff),(32,0,0xffffffff)]
        raw=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in entries)
        for name in ('access','default'):os.setxattr(self.f.state,'system.posix_acl_'+name,raw)
        original=self.f.state.stat();changed=[False]
        def host(step):
            if step=='run' and not changed[0]:
                entries[1]=(2,6,os.getuid()+1)
                altered=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in entries)
                os.setxattr(self.f.state,'system.posix_acl_'+kind,altered);changed[0]=True
            return 'd'*64
        with self.f.hold() as self.tx:
            runner=self.runner(host=host)
            try:runner.prepare()
            except RuntimeError as error:self.assertEqual(str(error),'SEC014_PREPARE_PHASE_UNCONFIRMED')
            print('PARENT_ACL_CHANGE '+json.dumps(dict(kind=kind,prepareClients=len(self.commands),
                mode=format(self.f.state.stat().st_mode&0o777,'04o'))),flush=True)
            self.assertEqual(self.commands,[])
            self.assertTrue(changed[0])
            record=json.loads((self.f.root/'to-server-prepare-parent.json').read_bytes())
            self.assertEqual(record['acls'],{name:dict(rawHex=raw.hex(),errno=None) for name in ('access','default')})
            self.assertEqual((self.f.state.stat().st_ino,self.f.state.stat().st_mode),(original.st_ino,original.st_mode))
            self.assertFalse(record['hostAuthority'])
            self.assertIsNone(runner.parent_fd)
            self.assertEqual(self.journal()['phases'],[])

    def test_parent_access_acl_change_refuses_before_client(self):
        self.parent_acl_change('access')

    def test_parent_default_acl_change_refuses_before_client(self):
        self.parent_acl_change('default')

    def parent_acl_read_failure(self,oversize):
        get=os.getxattr;calls=[];seen=[];invalidated=[]
        def observe(path,name,*args,**kwargs):
            if (type(path) is int and os.readlink('/proc/thread-self/fd/'+str(path))==str(self.f.state)):
                seen.append((path,name))
                if oversize and name=='system.posix_acl_default':return b'x'*4097
                if not oversize:raise OSError(errno.EACCES,'synthetic parent ACL unreadable')
            return get(path,name,*args,**kwargs)
        def host(step):calls.append(step);return 'd'*64
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(os,'getxattr',side_effect=observe):
            runner=self.runner(host=host)
            try:runner.prepare()
            except RuntimeError as error:self.assertEqual(str(error),'SEC014_PREPARE_PHASE_UNCONFIRMED')
            print('PARENT_ACL_READ '+json.dumps(dict(oversize=oversize,hostCalls=len(calls),
                prepareClients=len(self.commands),fdReads=len(seen))),flush=True)
            self.assertEqual(self.commands,[])
            self.assertEqual(calls,[])
            self.assertTrue(seen)
            for fd,_ in seen:
                with self.assertRaises(OSError):os.fstat(fd)
            self.assertEqual(set(invalidated),{'UNCONFIRMED_CHILD'})
            self.assertIsNone(runner.parent_fd)
            self.assertFalse((self.f.root/'to-server-prepare-parent.json').exists())
            self.assertEqual(self.journal()['phases'],[])

    def test_parent_acl_error_refuses_before_host_step(self):
        self.parent_acl_read_failure(False)

    def test_parent_default_acl_oversize_refuses_before_host_step(self):
        self.parent_acl_read_failure(True)

    def test_symlink_parent_refuses_before_host_step_or_client(self):
        target=self.f.state.with_name('retained-state')
        self.f.state.rename(target);self.f.state.symlink_to(target,target_is_directory=True)
        calls=[]
        def host(step):calls.append(step);return 'd'*64
        with self.f.hold() as self.tx:
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):
                self.runner(host=host).prepare()
            self.assertEqual(self.commands,[])
            self.assertEqual(calls,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_parent_same_inode_different_mount_refuses_before_client(self):
        real_open=Path.open;injected=[]
        def fdinfo(path,*args,**kwargs):
            stream=real_open(path,*args,**kwargs)
            if (str(path).startswith('/proc/thread-self/fdinfo/')
                    and os.readlink('/proc/thread-self/fd/'+path.name)==str(self.f.state)):
                with stream:raw=stream.read()
                if int(path.name)!=runner.parent_fd:
                    original=re.search(rb'(?m)^mnt_id:\s*([0-9]+)$',raw)
                    self.assertIsNotNone(original)
                    changed=str(int(original.group(1))+1).encode()
                    raw=raw[:original.start(1)]+changed+raw[original.end(1):]
                    injected.append(int(path.name))
                return io.BytesIO(raw)
            return stream
        with self.f.hold() as self.tx,patch.object(Path,'open',fdinfo):
            runner=self.runner()
            try:runner.prepare()
            except p.actor.control.ControlError:pass
            self.assertEqual(self.commands,[])
            self.assertTrue(injected)
            for fd in injected:
                with self.assertRaises(OSError):os.fstat(fd)
            self.assertTrue(runner.held)
            self.assertIsNone(runner.parent_fd)
            self.assertEqual(self.journal()['phases'],[])

    def test_parent_namespace_change_at_final_callback_refuses_before_client(self):
        changed=[False];calls=[];real_stat=os.stat
        def host(step):
            if step=='run':
                calls.append(step)
                if len(calls)==2:changed[0]=True
            return 'd'*64
        def namespace(path,*args,**kwargs):
            info=real_stat(path,*args,**kwargs)
            if str(path)=='/proc/thread-self/ns/mnt' and changed[0]:
                return SimpleNamespace(st_dev=info.st_dev,st_ino=info.st_ino+1)
            return info
        with self.f.hold() as self.tx,patch.object(os,'stat',namespace):
            runner=self.runner(host=host)
            try:runner.prepare()
            except p.actor.control.ControlError:pass
            self.assertEqual(self.commands,[])
            self.assertEqual(len(calls),2)
            self.assertTrue(runner.held)
            self.assertIsNone(runner.parent_fd)
            changed[0]=False
            self.tx.check()
            self.assertEqual(self.journal()['phases'],[])

    def test_parent_unusable_fdinfo_refuses_before_client(self):
        real_open=Path.open
        def fdinfo(path,*args,**kwargs):
            if (str(path).startswith('/proc/thread-self/fdinfo/')
                    and os.readlink('/proc/thread-self/fd/'+path.name)==str(self.f.state)):
                return io.BytesIO(b'pos:\t0\nmnt_id:\tunknown\n')
            return real_open(path,*args,**kwargs)
        with self.f.hold() as self.tx,patch.object(Path,'open',fdinfo):
            runner=self.runner()
            try:runner.prepare()
            except p.actor.control.ControlError:pass
            self.assertEqual(self.commands,[])
            self.assertTrue(runner.held)
            self.assertIsNone(runner.parent_fd)
            self.assertFalse((self.f.root/'to-server-prepare-parent.json').exists())
            self.assertEqual(self.journal()['phases'],[])

    def socket_mount_refusal(self,mode):
        real_open=Path.open;real_fd_open=os.open;opened=[];observed=[];calls=[]
        def fd_open(path,flags,*args,**kwargs):
            fd=real_fd_open(path,flags,*args,**kwargs)
            if path==self.socket_path and flags&os.O_PATH:opened.append(fd)
            return fd
        def fdinfo(path,*args,**kwargs):
            stream=real_open(path,*args,**kwargs)
            if (str(path).startswith('/proc/thread-self/fdinfo/')
                    and os.readlink('/proc/thread-self/fd/'+path.name)==str(self.socket_path)):
                with stream:raw=stream.read()
                observed.append(int(path.name))
                if mode=='oversize':raw=b' '*4097
                elif mode=='duplicate':raw+=b'mnt_id:\t1\n'
                elif len(observed)==2:
                    match=re.search(rb'(?m)^mnt_id:[ \t]*([0-9]+)$',raw)
                    raw=raw[:match.start(1)]+str(int(match.group(1))+1).encode()+raw[match.end(1):]
                return io.BytesIO(raw)
            return stream
        def host(step):return 'd'*64
        host.bind_image=lambda *args:calls.append(args)
        host.invalidate=lambda reason:None
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path), \
                patch.object(os,'open',side_effect=fd_open),patch.object(Path,'open',fdinfo):
            try:p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                          datetime.now(timezone.utc)+timedelta(seconds=120),host)
            except RuntimeError as error:self.assertEqual(str(error),'SEC014_CONTROL_DOCKER_SOCKET_MOUNT')
            print('SOCKET_MOUNT_REFUSAL '+json.dumps(dict(mode=mode,bindingCalls=len(calls),
                socketFds=len(opened),fdinfoReads=len(observed))),flush=True)
            self.assertEqual(calls,[])
            self.assertTrue(observed)
            self.assertEqual(len(opened),2)
            for fd in opened:
                with self.assertRaises(OSError):os.fstat(fd)
            self.assertFalse((self.f.root/'to-server-prepare-socket.json').exists())
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_socket_duplicate_mount_id_refuses_before_binding(self):
        self.socket_mount_refusal('duplicate')

    def test_socket_oversize_fdinfo_refuses_before_binding(self):
        self.socket_mount_refusal('oversize')

    def test_socket_named_mount_mismatch_refuses_before_binding(self):
        self.socket_mount_refusal('named')

    def test_socket_mount_change_after_callback_refuses_before_client(self):
        real_open=Path.open;changed=[False];seen=[]
        def fdinfo(path,*args,**kwargs):
            stream=real_open(path,*args,**kwargs)
            if (str(path).startswith('/proc/thread-self/fdinfo/')
                    and os.readlink('/proc/thread-self/fd/'+path.name)==str(self.socket_path)):
                with stream:raw=stream.read()
                if changed[0]:
                    match=re.search(rb'(?m)^mnt_id:[ \t]*([0-9]+)$',raw)
                    raw=raw[:match.start(1)]+str(int(match.group(1))+1).encode()+raw[match.end(1):]
                    seen.append(int(path.name))
                return io.BytesIO(raw)
            return stream
        def host(step):
            if step=='run':changed[0]=True
            return 'd'*64
        with self.f.hold() as self.tx,patch.object(Path,'open',fdinfo):
            runner=self.runner(host=host)
            original=(self.f.root/'to-server-prepare-socket.json').read_bytes()
            try:runner.prepare()
            except p.actor.control.ControlError:pass
            print('SOCKET_MOUNT_CHANGE '+json.dumps(dict(prepareClients=len(self.commands),
                changedFdReads=len(seen))),flush=True)
            self.assertEqual(self.commands,[])
            self.assertTrue(seen)
            endpoint=json.loads(original)
            self.assertIn('mnt_id:\t'+str(endpoint['mountId'])+'\n',endpoint['fdinfoUtf8'])
            self.assertFalse(endpoint['hostAuthority'])
            self.assertEqual((self.f.root/'to-server-prepare-socket.json').read_bytes(),original)
            changed[0]=False
            self.tx.check()
            self.assertEqual(self.journal()['phases'],[])

    def test_four_fixed_commands_env_terminal_before_reap_and_phase_evidence(self):
        with self.f.hold() as self.tx, patch.dict(os.environ,{'BELLTEAM_WEB_TOKEN':'synthetic-secret','DOCKER_HOST':'invalid'}):
            self.tx.confirmed('writers_stopped')
            runner=self.runner()
            receipt=runner.prepare()
            self.assertIsNone(runner.parent_fd)
            parent_raw=(self.f.root/'to-server-prepare-parent.json').read_bytes()
            parent=json.loads(parent_raw)
            self.assertEqual((parent['device'],parent['inode']),
                             (str(self.f.state.stat().st_dev),str(self.f.state.stat().st_ino)))
            self.assertFalse(parent['hostAuthority'])
            self.assertIs(type(parent['mountId']),int)
            self.assertIn('mnt_id:\t'+str(parent['mountId'])+'\n',parent['fdinfoUtf8'])
            namespace=os.stat('/proc/thread-self/ns/mnt')
            self.assertEqual(parent['mountNamespace'],
                             dict(device=str(namespace.st_dev),inode=str(namespace.st_ino)))
            chain=json.loads((self.f.root/'to-server-prepare-chain.json').read_bytes())
            self.assertEqual(chain['parentObservationSha256'],hashlib.sha256(parent_raw).hexdigest())
            socket_raw=(self.f.root/'to-server-prepare-socket.json').read_bytes()
            endpoint=json.loads(socket_raw)
            self.assertEqual(endpoint['dockerHost'],'unix://'+str(self.socket_path))
            self.assertEqual(endpoint['inode'],str(self.socket_path.stat().st_ino))
            self.assertFalse(endpoint['hostAuthority'])
            self.assertEqual(endpoint['accessAcl'],dict(rawHex=None,errno=errno.ENODATA))
            self.assertEqual(chain['socketObservationSha256'],hashlib.sha256(socket_raw).hexdigest())
            self.assertEqual(chain['imageObservationSha256'],hashlib.sha256(
                (self.f.root/'to-server-writer-image.output.json').read_bytes()).hexdigest())
            self.assertEqual(len(self.commands),4)
            self.assertEqual(self.commands[0][0],['/usr/bin/docker','compose','--env-file','/dev/null','-f',
                '/home/kite/BellTeam/compose.state-prepare.yaml','run','--no-deps','--name',p.actor.prepare_name(self.tx),'-T','state-prepare'])
            self.assertEqual(self.commands[2][0],['/usr/bin/docker','rm',CID])
            self.assertNotIn('.Config.Env',self.commands[1][0][5])
            for argv,env in self.commands:
                self.assertEqual(set(env),{'PATH','HOME','LANG','DOCKER_CONFIG','DOCKER_HOST','BELLTEAM_SERVER_IMAGE','BELLTEAM_STATE_PARENT'})
                self.assertEqual(env['DOCKER_HOST'],'unix://'+str(self.socket_path))
                self.assertEqual(list(Path(env['DOCKER_CONFIG']).iterdir()),[])
            self.assertEqual(len(self.reaped),4)
            self.assertEqual(self.journal()['phases'],['writers_stopped'])
            p.actor._receipt(self.tx,'prepared',IMAGE,receipt,p.actor.PROOFS[1]);self.tx.confirmed('prepared')
        self.assertEqual(self.journal()['phases'],['writers_stopped','prepared'])
        self.assertEqual(self.journal()['status'],'incomplete')

    def test_running_container_never_reaches_remove_or_phase(self):
        self.mutate=lambda value:dict(value,status='running',running=True,pid=123)
        with self.f.hold() as self.tx:
            runner=self.runner()
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):runner.prepare()
            self.assertTrue(runner.held)
        self.assertEqual(len(self.commands),2)
        self.assertFalse((self.f.root/'to-server-prepare-evidence.json').exists())
        self.assertEqual(self.journal()['phases'],[])

    def test_socket_replacement_at_final_callback_refuses_before_client(self):
        calls=[]
        replacement=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        self.addCleanup(replacement.close)
        def host(step):
            if step=='run':
                calls.append(step)
                if len(calls)==2:
                    self.socket_path.rename(self.socket_path.with_name('retained.sock'))
                    replacement.bind(str(self.socket_path));self.socket_path.chmod(0o660)
            return 'd'*64
        with self.f.hold() as self.tx:
            runner=self.runner(host=host)
            try:runner.prepare()
            except p.actor.control.ControlError:pass
            self.assertEqual(self.commands,[])
            self.assertTrue(runner.held)
            self.assertEqual(self.journal()['phases'],[])

    def test_non_socket_endpoint_refuses_before_host_step_or_client(self):
        self.socket_path.unlink();self.socket_path.write_bytes(b'not a socket')
        calls=[]
        def host(step):calls.append(step);return 'd'*64
        with self.f.hold() as self.tx:
            with self.assertRaisesRegex(RuntimeError,'DOCKER_SOCKET'):self.runner(host=host)
            self.assertEqual(self.commands,[])
            self.assertEqual(calls,[])
            self.assertFalse((self.f.root/'to-server-prepare-socket.json').exists())
            self.assertEqual(self.journal()['phases'],[])

    def test_extra_mount_never_reaches_remove_or_phase(self):
        self.mutate=lambda v:dict(v,mounts=v['mounts']+[dict(Type='bind',Source='/x',Destination='/home/bell',RW=True)])
        with self.f.hold() as self.tx:
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):self.runner().prepare()
        self.assertEqual(len(self.commands),2)
        self.assertEqual(self.journal()['phases'],[])

    def test_old_container_birth_cannot_be_adopted_after_cli_exit0(self):
        old=(datetime.now(timezone.utc)-timedelta(hours=1)).isoformat()
        self.mutate=lambda v:dict(v,createdAt=old,startedAt=old,finishedAt=old)
        with self.f.hold() as self.tx:
            with self.assertRaises(p.actor.control.ControlError):self.runner().prepare()
        self.assertEqual(len(self.commands),2)
        self.assertEqual(self.journal()['phases'],[])

    def test_output_limit_holds_without_inspect_or_error_body_saved(self):
        self.output=b'sensitive-marker'*400
        with self.f.hold() as self.tx:
            runner=self.runner()
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):runner.prepare()
            self.assertTrue(runner.held)
        self.assertEqual(len(self.commands),1)
        self.assertEqual(self.reaped,[])
        records=b''.join(x.read_bytes() for x in self.f.root.glob('*.json'))
        self.assertNotIn(b'sensitive-marker',records)
        self.assertEqual(self.journal()['phases'],[])

    def test_claim_io_expiry_refuses_before_first_child_and_no_retry(self):
        mono=[1000.0];save=p.actor._save_json
        def expire(tx,name,value):
            result=save(tx,name,value)
            if name.endswith('run.claim.json'):mono[0]=1111
            return result
        with self.f.hold() as self.tx,patch.object(p.time,'monotonic',side_effect=lambda:mono[0]):
            runner=self.runner(deadline=1110)
            with patch.object(p.actor,'_save_json',side_effect=expire):
                with self.assertRaises(p.actor.control.ControlError):runner.prepare()
            with self.assertRaises(p.actor.control.ControlError):runner.call('run')
        self.assertEqual(self.commands,[])
        self.assertEqual(self.journal()['phases'],[])

    def test_terminal_persistence_failure_never_reaps_or_inspects(self):
        save=p.actor._save_json
        def fail(tx,name,value):
            if name.endswith('run.terminal.json'):raise OSError('synthetic terminal persistence')
            return save(tx,name,value)
        with self.f.hold() as self.tx,patch.object(p.actor,'_save_json',side_effect=fail):
            with self.assertRaises(p.actor.control.ControlError):self.runner().prepare()
        self.assertEqual(len(self.commands),1)
        self.assertEqual(self.reaped,[])
        self.assertIsNotNone(os.waitid(os.P_PID,self.children[0].pid,os.WEXITED|os.WNOWAIT|os.WNOHANG))
        self.assertEqual(self.journal()['phases'],[])

    def test_missing_host_original_refuses_before_docker(self):
        def missing(step):raise RuntimeError('authority unavailable')
        with self.f.hold() as self.tx:
            with self.assertRaises(p.actor.control.ControlError):self.runner(host=missing).prepare()
        self.assertEqual(self.commands,[])
        self.assertEqual(self.journal()['phases'],[])


if __name__=='__main__':unittest.main(verbosity=2)
