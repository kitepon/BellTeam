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

    def binding_expiry_case(self,mode):
        mono=[1000.0];real_save=p.actor._save_json;seen=[];invalidated=[];saved=[];opened=[];real_open=os.open
        class Clock(datetime):
            @classmethod
            def now(cls,tz=None):return wall[0]
        wall=[Clock(2026,10,30,tzinfo=timezone.utc)];end=wall[0]+timedelta(seconds=120)
        def expire():
            if mode.startswith('mono'):mono[0]=1109.0
            else:wall[0]=end
        def save(tx,name,value):
            result=real_save(tx,name,value)
            if name.endswith('-prepare-parent.json'):
                saved.append(json.loads((self.f.root/name).read_bytes()))
                if mode.endswith('before'):expire()
            return result
        def fdopen(path,flags,*args,**kwargs):
            value=real_open(path,flags,*args,**kwargs)
            if flags&os.O_DIRECTORY:opened.append(value)
            return value
        def host(step):self.fail('constructor must not run a prepare host step')
        def bind(*args):
            seen.append(args)
            if mode.endswith('after'):expire()
        host.bind_image,host.invalidate=bind,invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path), \
                patch.object(p.time,'monotonic',side_effect=lambda:mono[0]),patch.object(p,'datetime',Clock), \
                patch.object(p.actor,'_save_json',side_effect=save),patch.object(os,'open',side_effect=fdopen):
            caught=None;runner=None
            try:runner=p._Prepare(self.tx,IMAGE,IMAGE_ID,1110.0,end,host)
            except BaseException as error:caught=error
            print('BINDING_EXPIRY '+json.dumps(dict(mode=mode,bindings=len(seen),
                invalidations=len(invalidated),error=None if caught is None else str(caught))),flush=True)
            self.assertIsNotNone(caught)
            self.assertEqual(str(caught),'SEC014_PREPARE_DEADLINE_OR_HELD')
            self.assertIsNone(runner)
            self.assertEqual(len(seen),0 if mode.endswith('before') else 1)
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertEqual(len(saved),1)
            path=self.f.root/'to-server-prepare-parent.json'
            self.assertEqual(json.loads(path.read_bytes()),saved[0])
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            for value in opened:
                with self.assertRaises(OSError):os.fstat(value)
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_binding_monotonic_expiry_after_observation_refuses_callback(self):
        self.binding_expiry_case('mono-before')

    def test_binding_window_expiry_after_observation_refuses_callback(self):
        self.binding_expiry_case('window-before')

    def test_binding_monotonic_expiry_inside_callback_invalidates_constructor(self):
        self.binding_expiry_case('mono-after')

    def test_binding_window_expiry_inside_callback_invalidates_constructor(self):
        self.binding_expiry_case('window-after')

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

    def parent_binding_case(self,mode):
        real_open=os.open;real_save=p.actor._save_json;opened=[];seen=[];invalidated=[]
        original=self.f.state.stat();failure=OSError('synthetic parent original durability failure')
        entries=[(1,7,0xffffffff),(2,4,os.getuid()+1),(4,0,0xffffffff),(16,0,0xffffffff),(32,0,0xffffffff)]
        acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in entries)
        if mode=='acl':os.setxattr(self.f.state,'system.posix_acl_default',acl)
        def fd_open(path,flags,*args,**kwargs):
            fd=real_open(path,flags,*args,**kwargs)
            if flags&os.O_DIRECTORY:opened.append(fd)
            return fd
        def save(tx,name,value):
            if mode=='save' and name.endswith('-prepare-parent.json'):raise failure
            return real_save(tx,name,value)
        def host(step):return 'd'*64
        def bind(*args):
            path=self.f.root/'to-server-prepare-parent.json'
            seen.append(json.loads(path.read_bytes()) if path.exists() else None)
            for fd in opened:
                with self.assertRaises(OSError):os.fstat(fd)
            if mode=='replace':
                self.f.state.rename(self.f.state.with_name('old-parent'));self.f.state.mkdir(mode=0o700)
            elif mode=='acl':
                entries[1]=(2,6,os.getuid()+1)
                os.setxattr(self.f.state,'system.posix_acl_default',struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in entries))
        host.bind_image,host.invalidate=bind,invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path), \
                patch.object(os,'open',side_effect=fd_open),patch.object(p.actor,'_save_json',side_effect=save):
            caught=None;runner=None
            try:runner=p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                                 datetime.now(timezone.utc)+timedelta(seconds=120),host)
            except BaseException as error:caught=error
            print('PARENT_BEFORE_BIND '+json.dumps(dict(mode=mode,bindingCalls=len(seen),
                originalSeen=bool(seen and seen[0]),refused=caught is not None)),flush=True)
            if mode=='observe':
                self.assertIsNone(caught)
                self.assertIsNotNone(seen[0])
                self.assertEqual(seen[0]['inode'],str(original.st_ino))
                self.assertIsNone(runner.parent_fd)
            else:
                if mode=='save':self.assertIs(caught,failure);self.assertEqual(seen,[])
                else:self.assertEqual(str(caught),'SEC014_PREPARE_PARENT_CHANGED')
                self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            for fd in opened:
                with self.assertRaises(OSError):os.fstat(fd)
            path=self.f.root/'to-server-prepare-parent.json'
            if mode=='save':self.assertFalse(path.exists())
            else:
                self.assertEqual(json.loads(path.read_bytes()),seen[0])
                self.assertFalse(seen[0]['hostAuthority'])
                self.assertEqual(path.stat().st_mode&0o777,0o600)
                if mode=='acl':self.assertEqual(seen[0]['acls']['default'],dict(rawHex=acl.hex(),errno=None))
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_parent_original_is_saved_before_image_binding(self):
        self.parent_binding_case('observe')

    def test_parent_replacement_inside_image_binding_refuses_constructor(self):
        self.parent_binding_case('replace')

    def test_parent_default_acl_change_inside_image_binding_refuses_constructor(self):
        self.parent_binding_case('acl')

    def test_parent_original_save_failure_refuses_image_binding(self):
        self.parent_binding_case('save')

    def ancestor_change(self,acl):
        ancestor=self.f.state.parent;original=ancestor.stat();changed=[False]
        entries=[(1,7,0xffffffff),(2,4,os.getuid()+1),(4,0,0xffffffff),(16,0,0xffffffff),(32,0,0xffffffff)]
        raw=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in entries)
        def host(step):
            if step=='run' and not changed[0]:
                if acl:os.setxattr(ancestor,'system.posix_acl_default',raw)
                else:ancestor.chmod(0o750)
                changed[0]=True
            return 'd'*64
        with self.f.hold() as self.tx:
            runner=self.runner(host=host)
            original_parent=(self.f.root/'to-server-prepare-parent.json').read_bytes()
            try:runner.prepare()
            except RuntimeError as error:self.assertEqual(str(error),'SEC014_PREPARE_PHASE_UNCONFIRMED')
            print('ANCESTOR_CHANGE '+json.dumps(dict(acl=acl,clients=len(self.commands))),flush=True)
            self.assertEqual(self.commands,[])
            self.assertTrue(changed[0])
            record=json.loads(original_parent)
            self.assertEqual([item['path'] for item in record['ancestors']],
                             [str(path) for path in reversed(self.f.state.parents)])
            saved=next(item for item in record['ancestors'] if item['path']==str(ancestor))
            self.assertEqual((saved['device'],saved['inode']),(str(original.st_dev),str(original.st_ino)))
            self.assertEqual(saved['mode'],'0700')
            self.assertEqual(saved['acls']['default'],dict(rawHex=None,errno=errno.ENODATA))
            self.assertFalse(saved['hostAuthority'])
            self.assertEqual((self.f.root/'to-server-prepare-parent.json').read_bytes(),original_parent)
            self.assertIsNone(runner.parent_fd)
            self.assertEqual(self.journal()['phases'],[])

    def test_ancestor_mode_change_refuses_before_client(self):
        self.ancestor_change(False)

    def test_ancestor_default_acl_change_refuses_before_client(self):
        self.ancestor_change(True)

    def test_ancestor_symlink_in_binding_is_not_followed(self):
        ancestor=self.f.state.parent;retained=ancestor.with_name(ancestor.name+'-retained');invalidated=[]
        real_open=os.open;opened=[];bound=[]
        def fd_open(path,flags,*args,**kwargs):
            fd=real_open(path,flags,*args,**kwargs)
            if flags&os.O_DIRECTORY:opened.append(fd)
            return fd
        def host(step):return 'd'*64
        def bind(*args):
            bound.append(args);ancestor.rename(retained);ancestor.symlink_to(retained,target_is_directory=True)
        host.bind_image,host.invalidate=bind,invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path),patch.object(os,'open',side_effect=fd_open):
            caught=None
            try:
                try:p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,datetime.now(timezone.utc)+timedelta(seconds=120),host)
                except BaseException as error:caught=error
            finally:
                if ancestor.is_symlink():ancestor.unlink();retained.rename(ancestor)
            print('ANCESTOR_SYMLINK '+json.dumps(dict(refused=caught is not None,opened=len(opened),bindingCalls=len(bound))),flush=True)
            self.assertEqual(len(bound),1)
            self.assertIsInstance(caught,OSError)
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            for fd in opened:
                with self.assertRaises(OSError):os.fstat(fd)
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_ancestor_acl_total_budget_refuses_before_binding(self):
        real_get=os.getxattr;real_open=os.open;opened=[];calls=[];invalidated=[]
        def fd_open(path,flags,*args,**kwargs):
            fd=real_open(path,flags,*args,**kwargs)
            if flags&os.O_DIRECTORY:opened.append(fd)
            return fd
        def get(path,name,*args,**kwargs):
            if type(path) is int:return b'x'*4096
            return real_get(path,name,*args,**kwargs)
        def host(step):return 'd'*64
        host.bind_image=lambda *args:calls.append(args)
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path),patch.object(os,'getxattr',side_effect=get),patch.object(os,'open',side_effect=fd_open):
            caught=None
            try:p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,datetime.now(timezone.utc)+timedelta(seconds=120),host)
            except RuntimeError as error:caught=str(error)
            print('ANCESTOR_BUDGET '+json.dumps(dict(error=caught,bindingCalls=len(calls))),flush=True)
            self.assertEqual(caught,'SEC014_PREPARE_PARENT_OBSERVATION_LIMIT')
            self.assertEqual(calls,[])
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            for fd in opened:
                with self.assertRaises(OSError):os.fstat(fd)
            self.assertFalse((self.f.root/'to-server-prepare-parent.json').exists())
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
            with self.assertRaisesRegex(p.actor.control.ControlError,'CONTROL_METADATA'):
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
            runner=None
            try:runner=self.runner(host=host);runner.prepare()
            except OSError as error:self.assertEqual(error.errno,errno.EACCES)
            except RuntimeError as error:self.assertEqual(str(error),'SEC014_PREPARE_PARENT_ACL_LIMIT')
            print('PARENT_ACL_READ '+json.dumps(dict(oversize=oversize,hostCalls=len(calls),
                prepareClients=len(self.commands),fdReads=len(seen))),flush=True)
            self.assertEqual(self.commands,[])
            self.assertEqual(calls,[])
            self.assertTrue(seen)
            for fd,_ in seen:
                with self.assertRaises(OSError):os.fstat(fd)
            self.assertEqual(set(invalidated),{'UNCONFIRMED_CHILD'})
            self.assertIsNone(runner)
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
            with self.assertRaises(OSError):
                self.runner(host=host).prepare()
            self.assertEqual(self.commands,[])
            self.assertEqual(calls,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_parent_same_inode_different_mount_refuses_before_client(self):
        real_open=Path.open;injected=[];runner=None
        def fdinfo(path,*args,**kwargs):
            stream=real_open(path,*args,**kwargs)
            if (str(path).startswith('/proc/thread-self/fdinfo/')
                    and os.readlink('/proc/thread-self/fd/'+path.name)==str(self.f.state)):
                with stream:raw=stream.read()
                if runner is not None and int(path.name)!=runner.parent_fd:
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
        real_open=Path.open;runner=None
        def fdinfo(path,*args,**kwargs):
            if (runner is not None and str(path).startswith('/proc/thread-self/fdinfo/')
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
            self.assertTrue((self.f.root/'to-server-prepare-parent.json').exists())
            self.assertEqual(self.journal()['phases'],[])

    def socket_mountinfo_case(self,mode):
        real_open=Path.open;real_fdopen=os.open;real_xattr=os.getxattr
        opened=[];changed=[False];seen=[];invalidated=[]
        fd=os.open(self.socket_path,os.O_PATH|os.O_NOFOLLOW)
        try:mount=int(re.search(r'(?m)^mnt_id:\s*([0-9]+)$',Path('/proc/thread-self/fdinfo/'+str(fd)).read_text())[1])
        finally:os.close(fd)
        table=Path('/proc/thread-self/mountinfo').read_bytes()
        line=next(row for row in table.splitlines() if row.startswith(str(mount).encode()+b' '))
        fields=line.split();self.assertNotEqual(fields[2],b'0:0');options=fields[5].split(b',')
        fields[5]=b','.join([x for x in options if x!=b'noexec'] if b'noexec' in options else options+[b'noexec'])
        altered=b' '.join(fields)
        large=line.replace(b' - ',b' x:'+b'x'*57000+b' - ')
        self.assertLessEqual(len(table.replace(line,large)),65536)
        def read(path,*args,**kwargs):
            if str(path)=='/proc/thread-self/mountinfo':
                raw=table
                if mode=='change' and changed[0]:raw=table.replace(line,altered)
                elif mode=='duplicate':raw=table+line+b'\n'
                elif mode=='device':
                    wrong=line.split();wrong[2]=b'0:0';raw=table.replace(line,b' '.join(wrong))
                elif mode=='separator':raw=table.replace(line,line.replace(b' - ',b' ! '))
                elif mode=='oversize':raw=b'x'*65537
                elif mode=='record':raw=table.replace(line,large)
                return io.BytesIO(raw)
            return real_open(path,*args,**kwargs)
        def xattr(path,*args,**kwargs):
            if mode=='record' and path==self.socket_path:return b'x'*4096
            return real_xattr(path,*args,**kwargs)
        def fdopen(path,flags,*args,**kwargs):
            value=real_fdopen(path,flags,*args,**kwargs)
            if path==self.socket_path and flags&os.O_PATH:opened.append(value)
            return value
        def host(step):
            if step=='run':changed[0]=True
            return 'd'*64
        def bind(*args):seen.append((self.f.root/'to-server-prepare-socket.json').read_bytes())
        host.bind_image,host.invalidate=bind,invalidated.append
        with self.f.hold() as self.tx:
            original=type(self.tx)._socket_observation
            def observe(tx):
                with patch.object(Path,'open',read),patch.object(os,'getxattr',side_effect=xattr):return original(tx)
            with patch.object(type(self.tx),'_docker_socket_path',self.socket_path), \
                    patch.object(type(self.tx),'_socket_observation',observe),patch.object(os,'open',side_effect=fdopen):
                caught=None;runner=None
                try:
                    runner=p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                                      datetime.now(timezone.utc)+timedelta(seconds=120),host)
                    if mode=='change':runner.prepare()
                except BaseException as error:caught=error
                print('SOCKET_MOUNTINFO '+json.dumps(dict(mode=mode,bindings=len(seen),
                    clients=len(self.commands),changed=changed[0],error=None if caught is None else str(caught))),flush=True)
                self.assertIsNotNone(caught)
                self.assertEqual(self.commands,[])
                self.assertEqual(self.journal()['phases'],[])
                if mode=='change':
                    self.assertTrue(changed[0]);self.assertEqual(len(seen),1)
                    self.assertEqual(json.loads(seen[0])['mountInfoUtf8'],line.decode())
                    self.assertEqual((self.f.root/'to-server-prepare-socket.json').read_bytes(),seen[0])
                    self.assertTrue(runner.held)
                else:
                    self.assertEqual(str(caught),'SEC014_CONTROL_DOCKER_SOCKET_'+('OBSERVATION_LIMIT' if mode=='record' else 'MOUNTINFO'))
                    self.assertEqual(seen,[]);self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
                    self.assertFalse((self.f.root/'to-server-prepare-socket.json').exists())
                for value in opened:
                    with self.assertRaises(OSError):os.fstat(value)
                changed[0]=False

    def test_socket_mount_options_change_refuses_before_client(self):self.socket_mountinfo_case('change')
    def test_socket_mountinfo_duplicate_refuses_before_binding(self):self.socket_mountinfo_case('duplicate')
    def test_socket_mountinfo_device_mismatch_refuses_before_binding(self):self.socket_mountinfo_case('device')
    def test_socket_mountinfo_separator_missing_refuses_before_binding(self):self.socket_mountinfo_case('separator')
    def test_socket_mountinfo_table_oversize_refuses_before_binding(self):self.socket_mountinfo_case('oversize')
    def test_socket_mountinfo_record_budget_refuses_before_binding(self):self.socket_mountinfo_case('record')

    def socket_namespace_bracket_case(self,mode):
        real_stat=os.stat;real_open=os.open;real_path_open=Path.open
        switched=False;opened=[];calls=[];invalidated=[];triggers=[]
        namespace=real_stat('/proc/thread-self/ns/mnt')
        def changed(path,*args,**kwargs):
            value=real_stat(path,*args,**kwargs)
            if str(path)=='/proc/thread-self/ns/mnt' and switched:
                fields=list(value);fields[1]=namespace.st_ino+1
                return os.stat_result(fields)
            return value
        def fd_open(path,flags,*args,**kwargs):
            nonlocal switched
            fd=real_open(path,flags,*args,**kwargs)
            if path==self.socket_path and flags&os.O_PATH:
                opened.append(fd)
                if mode=='open' and not switched:switched=True;triggers.append('socket-open')
            return fd
        def path_open(path,*args,**kwargs):
            nonlocal switched
            stream=real_path_open(path,*args,**kwargs)
            if (mode=='fdinfo' and not switched and str(path).startswith('/proc/thread-self/fdinfo/')
                    and os.readlink('/proc/thread-self/fd/'+path.name)==str(self.socket_path)):
                switched=True;triggers.append('socket-fdinfo')
            return stream
        def host(step):return 'd'*64
        host.bind_image=lambda *args:calls.append(args)
        host.invalidate=invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path), \
                patch.object(os,'stat',side_effect=changed),patch.object(os,'open',side_effect=fd_open), \
                patch.object(Path,'open',path_open):
            caught=None
            try:p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                           datetime.now(timezone.utc)+timedelta(seconds=120),host)
            except RuntimeError as error:caught=error
            print('SOCKET_NAMESPACE_BRACKET '+json.dumps(dict(mode=mode,triggers=triggers,
                bindingCalls=len(calls),socketFds=len(opened),refused=None if caught is None else str(caught))),flush=True)
            self.assertEqual(len(triggers),1)
            self.assertEqual(calls,[])
            self.assertIsNotNone(caught)
            self.assertEqual(str(caught),'SEC014_CONTROL_DOCKER_SOCKET_NAMESPACE')
            self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
            self.assertEqual(len(opened),2)
            for fd in opened:
                with self.assertRaises(OSError):os.fstat(fd)
            self.assertFalse((self.f.root/'to-server-prepare-socket.json').exists())
            self.assertFalse((self.f.root/'to-server-prepare-parent.json').exists())
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])

    def test_socket_namespace_change_during_open_refuses_binding(self):
        self.socket_namespace_bracket_case('open')

    def test_socket_namespace_change_during_fdinfo_refuses_binding(self):
        self.socket_namespace_bracket_case('fdinfo')

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

    def mount_table_case(self,mode):
        real_open=Path.open;real_fdopen=os.open;opened=[];changed=[False];seen=[];invalidated=[]
        real_mount_info=p._Prepare._mount_info
        fd=os.open(self.f.state,os.O_RDONLY|os.O_DIRECTORY)
        try:
            mount=int(re.search(r'(?m)^mnt_id:\s*([0-9]+)$',Path('/proc/thread-self/fdinfo/'+str(fd)).read_text())[1])
        finally:os.close(fd)
        table=Path('/proc/thread-self/mountinfo').read_bytes()
        line=next(row for row in table.splitlines() if row.startswith(str(mount).encode()+b' '))
        fields=line.split();self.assertNotEqual(fields[2],b'0:0')
        options=fields[5].split(b',')
        fields[5]=b','.join([x for x in options if x!=b'noexec'] if b'noexec' in options else options+[b'noexec'])
        altered=b' '.join(fields)
        def read(path,*args,**kwargs):
            if str(path)=='/proc/thread-self/mountinfo':
                raw=table
                if mode=='change' and changed[0]:raw=table.replace(line,altered)
                elif mode=='duplicate':raw=table+line+b'\n'
                elif mode=='device':
                    wrong=line.split();wrong[2]=b'0:0';raw=table.replace(line,b' '.join(wrong))
                elif mode=='separator':raw=table.replace(line,line.replace(b' - ',b' ! '))
                elif mode=='oversize':raw=b'x'*65537
                return io.BytesIO(raw)
            return real_open(path,*args,**kwargs)
        def fdopen(path,flags,*args,**kwargs):
            value=real_fdopen(path,flags,*args,**kwargs)
            if flags&os.O_DIRECTORY:opened.append(value)
            return value
        def host(step):
            if step=='run':changed[0]=True
            return 'd'*64
        def mount_info(runner,fd):
            with patch.object(Path,'open',read):return real_mount_info(runner,fd)
        def bind(*args):seen.append(json.loads((self.f.root/'to-server-prepare-parent.json').read_bytes()))
        host.bind_image,host.invalidate=bind,invalidated.append
        with self.f.hold() as self.tx,patch.object(type(self.tx),'_docker_socket_path',self.socket_path), \
                patch.object(p._Prepare,'_mount_info',mount_info),patch.object(os,'open',side_effect=fdopen):
            caught=None
            try:
                runner=p._Prepare(self.tx,IMAGE,IMAGE_ID,time.monotonic()+110,
                                  datetime.now(timezone.utc)+timedelta(seconds=120),host)
                if mode=='change':runner.prepare()
            except BaseException as error:caught=error
            print('PARENT_MOUNTINFO '+json.dumps(dict(mode=mode,changed=changed[0],
                bindings=len(seen),clients=len(self.commands),error=None if caught is None else str(caught))),flush=True)
            self.assertIsNotNone(caught)
            self.assertEqual(self.commands,[])
            self.assertEqual(self.journal()['phases'],[])
            if mode=='change':
                self.assertTrue(changed[0]);self.assertEqual(len(seen),1)
                self.assertEqual(seen[0]['mountInfoUtf8'],line.decode())
                self.assertEqual(json.loads((self.f.root/'to-server-prepare-parent.json').read_bytes()),seen[0])
                self.assertFalse(seen[0]['hostAuthority'])
                self.assertIsNone(runner.parent_fd)
            else:
                self.assertEqual(str(caught),'SEC014_PREPARE_MOUNTINFO_UNCONFIRMED')
                self.assertEqual(seen,[])
                self.assertEqual(invalidated,['UNCONFIRMED_CHILD'])
                self.assertFalse((self.f.root/'to-server-prepare-parent.json').exists())
            for value in opened:
                with self.assertRaises(OSError):os.fstat(value)

    def test_parent_mount_options_change_refuses_before_client(self):
        self.mount_table_case('change')

    def test_parent_mountinfo_duplicate_refuses_before_binding(self):
        self.mount_table_case('duplicate')

    def test_parent_mountinfo_device_mismatch_refuses_before_binding(self):
        self.mount_table_case('device')

    def test_parent_mountinfo_separator_missing_refuses_before_binding(self):
        self.mount_table_case('separator')

    def test_parent_mountinfo_oversize_refuses_before_binding(self):
        self.mount_table_case('oversize')

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
