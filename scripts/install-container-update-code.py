#!/usr/bin/python3
"""Publish only the fixed updater closure from an explicitly approved immutable OCI image."""
import fcntl
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

PREFIX = Path('/srv/bellteam/shared/tools/bellteam-container-update-host')
PATHS = {
 '/app/scripts/container-update-host.py':'scripts/container-update-host.py',
 '/app/install.sh':'install.sh',
 '/app/scripts/cleanup-deploy-images.py':'scripts/cleanup-deploy-images.py',
 '/app/scripts/save-deploy-restore-point.py':'scripts/save-deploy-restore-point.py',
 '/app/scripts/verify-update-catalog.py':'scripts/verify-update-catalog.py',
 '/app/scripts/update_catalog.py':'scripts/update_catalog.py',
 '/app/scripts/module_artifact_verifier.py':'scripts/module_artifact_verifier.py',
 '/app/scripts/web_gateway_artifact.py':'scripts/web_gateway_artifact.py',
 '/app/config/update-catalog-verification.json':'config/update-catalog-verification.json',
 '/app/config/web-gateway-trusted-root.jsonl':'config/web-gateway-trusted-root.jsonl',
 '/app/distribution/server/updater/bellteam-container-update-host.service.in':'distribution/server/updater/bellteam-container-update-host.service.in',
 '/app/distribution/server/updater/bellteam-update-catalog-refresh.service.in':'distribution/server/updater/bellteam-update-catalog-refresh.service.in',
 '/app/distribution/server/updater/bellteam-update-catalog-refresh.timer':'distribution/server/updater/bellteam-update-catalog-refresh.timer',
 '/app/distribution/server/updater/compose.overlay.yaml':'distribution/server/updater/compose.overlay.yaml',
}

def trusted(path, uid=0, directory=False):
    path=Path(path)
    for item in [*reversed(path.parents),path]:
        info=item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid not in {0,uid} or info.st_mode & 0o22:
            raise ValueError('UPDATER_CODE_UNTRUSTED')
    info=path.lstat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink==1):
        raise ValueError('UPDATER_CODE_UNTRUSTED')
    return info

def _publish(image, source, *, prefix=PREFIX, uid=0, docker='/usr/bin/docker', command=None):
    if not re.fullmatch(r'ghcr.io/kitepon/bellteam-server@sha256:[a-f0-9]{64}', image) or not re.fullmatch('[a-f0-9]{40}',source):
        raise ValueError('UPDATER_CODE_ARGUMENTS')
    prefix=Path(prefix);trusted(prefix,uid,directory=True)
    releases=prefix/'releases';releases.mkdir(mode=0o755,exist_ok=True);trusted(releases,uid,directory=True)
    target=releases/source
    if os.path.lexists(target):raise ValueError('UPDATER_CODE_EXISTS')
    env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/root','DOCKER_HOST':'unix:///var/run/docker.sock',
         'DOCKER_CONFIG':str(prefix/'state/docker-config')}
    def run(args):
        if command:return command(args)
        return subprocess.run([docker,*args],env=env,cwd='/',stdin=subprocess.DEVNULL,capture_output=True,check=True,timeout=900).stdout
    container=None
    stage=Path(tempfile.mkdtemp(prefix='.code-',dir=releases))
    try:
        run(['pull',image])
        container=run(['create','--network','none','--entrypoint','/bin/true',image]).decode().strip()
        if not re.fullmatch('[a-f0-9]{64}',container):raise ValueError('UPDATER_CODE_CONTAINER')
        metadata=stage/'incoming-manifest.json'
        run(['cp',container+':/app/distribution/server/updater/root-code-manifest.json',str(metadata)])
        trusted(metadata,uid)
        if metadata.stat().st_size>65536:raise ValueError('UPDATER_CODE_MANIFEST')
        raw=metadata.read_bytes();manifest=json.loads(raw)
        if set(manifest)!={'schema','sourceCommit','files'} or (
            manifest['schema']!='bellteam.host-updater.code-manifest.v1' or manifest['sourceCommit']!=source
            or type(manifest['files']) is not list):
            raise ValueError('UPDATER_CODE_MANIFEST')
        found=set()
        for item in manifest['files']:
            if set(item)!={'imagePath','installPath','bytes','sha256'} or PATHS.get(item['imagePath'])!=item['installPath'] or item['imagePath'] in found:
                raise ValueError('UPDATER_CODE_MANIFEST')
            if type(item['bytes']) is not int or not 0<=item['bytes']<=16*1024*1024 or not re.fullmatch('[a-f0-9]{64}',item['sha256']):
                raise ValueError('UPDATER_CODE_MANIFEST')
            destination=stage/item['installPath'];destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            run(['cp',container+':'+item['imagePath'],str(destination)])
            info=trusted(destination,uid)
            if info.st_size!=item['bytes'] or hashlib.sha256(destination.read_bytes()).hexdigest()!=item['sha256']:
                raise ValueError('UPDATER_CODE_BYTES')
            destination.chmod(0o444)
            with destination.open('rb') as stream:os.fsync(stream.fileno())
            found.add(item['imagePath'])
        if found!=set(PATHS):raise ValueError('UPDATER_CODE_INCOMPLETE')
        metadata.unlink()
        receipt={'schema':'bellteam.host-updater.code-installation.v1','image':image,'sourceCommit':source,
                 'manifestSha256':hashlib.sha256(raw).hexdigest(),'protocolVersion':1,'ledgerSchema':1}
        for name,data in [('code-manifest.json',raw),('installation.json',(json.dumps(receipt)+'\n').encode())]:
            with (stage/name).open('xb') as stream:stream.write(data);stream.flush();os.fchmod(stream.fileno(),0o444);os.fsync(stream.fileno())
        for root,_,_ in os.walk(stage,topdown=False):
            os.chmod(root,0o555)
            fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
        # The stage and final directory share a parent; no DAC_OVERRIDE is needed for immutable rename.
        if target.exists():raise ValueError('UPDATER_CODE_EXISTS')
        libc=ctypes.CDLL(None,use_errno=True)
        if not hasattr(libc,'renameat2') or libc.renameat2(-100,os.fsencode(stage),-100,os.fsencode(target),1):
            raise ValueError('UPDATER_CODE_PUBLICATION_FAILED')
        fd=os.open(releases,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
        return receipt
    finally:
        try:
            if container:run(['rm',container])
        finally:
            if stage.exists():
                for root,_,_ in os.walk(stage):os.chmod(root,0o700)
                import shutil
                shutil.rmtree(stage)

def publish(image, source, *, prefix=PREFIX, uid=0, docker='/usr/bin/docker', command=None):
    prefix=Path(prefix);trusted(prefix,uid,directory=True)
    fd=os.open(prefix/'code.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        if info.st_uid!=uid or info.st_nlink!=1 or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600:
            raise ValueError('UPDATER_CODE_LOCK')
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        return _publish(image,source,prefix=prefix,uid=uid,docker=docker,command=command)
    finally:os.close(fd)

if __name__=='__main__':
    try:
        if os.getuid()!=0 or len(sys.argv)!=3:raise ValueError('UPDATER_CODE_ROOT_ARGUMENTS')
        trusted(Path(__file__).absolute());trusted('/usr/bin/docker')
        print(json.dumps(publish(sys.argv[1],sys.argv[2])))
    except Exception:
        sys.stderr.write('UPDATER_CODE_INSTALL_FAILED\n');sys.exit(1)
