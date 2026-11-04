#!/usr/bin/env python3
"""Fixed, one-shot public-installer bridge; no RPC and no caller-selected command."""
import contextlib
import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import re
import subprocess
import sys


def canonical(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


PREPARE_KEYS = 'schema,requestId,planId,originalOperationSha256,planSha256,targetSha256,storageBindingSha256,ledgerBinding,worker,oldService,target,preparedAt'
SERVICE_KEYS = 'containerId,imageId,sourceCommit,startedAt,pidNamespace,modelSha256,project'
TERMINATION_KEYS = 'schema,requestId,originalOperationSha256,prepareSha256,oldContainerId,status,running,restarting,pid,finishedAt,exitCode,stoppedAt'


def binding(path):
    info = Path(path).stat()
    return dict(device=str(info.st_dev), inode=str(info.st_ino))


def read_termination(updater, host, directory, value, plan, plan_sha):
    """Called with worker/ledger/private/component locks already held by the backend."""
    record = host.read_json(directory / 'worker-termination.json', updater.uid)
    host.check(host.exact(record, 'prepareSha256,prepare,terminationSha256,termination'), 'HOST_MODULE_TERMINATION_UNCONFIRMED', 409)
    p, t = record['prepare'], record['termination']
    host.check(host.exact(p, PREPARE_KEYS) and host.exact(t, TERMINATION_KEYS)
        and host.exact(p['oldService'], SERVICE_KEYS) and host.exact(p['target'], 'sourceCommit,imageId')
        and p['schema'] == 'bellteam.module-worker-prepare.v1'
        and t['schema'] == 'bellteam.module-worker-termination.v1', 'HOST_MODULE_TERMINATION_UNCONFIRMED', 409)
    host.check(host.digest(record['prepareSha256']) == digest(p)
        and host.digest(record['terminationSha256']) == digest(t)
        and host.read_json(directory / 'worker-termination-prepare.json', updater.uid) == p,
        'HOST_MODULE_TERMINATION_UNCONFIRMED', 409)
    original = hashlib.sha256((directory / 'operation.json').read_bytes()).hexdigest()
    host.check(p['requestId'] == t['requestId'] == value['requestId'] and p['planId'] == plan['planId']
        and p['originalOperationSha256'] == t['originalOperationSha256'] == original
        and p['planSha256'] == plan_sha and p['targetSha256'] == digest(plan['target'])
        and p['storageBindingSha256'] == digest(plan['expected']['privateVolume'])
        and p['ledgerBinding'] == binding(updater.prefix) and p['worker'] == value['worker']
        and p['oldService']['pidNamespace'] == value['worker']['pidNamespace']
        and p['oldService']['sourceCommit'] == plan['expected']['sourceCommit']
        and p['target']['sourceCommit'] == updater.config['release']
        and updater.inspect_current()['privateVolume'] == plan['expected']['privateVolume'],
        'HOST_MODULE_TERMINATION_UNCONFIRMED', 409)
    worker=value['worker']
    host.check(host.exact(worker,'pid,birth,pidNamespace') and type(worker['pid']) is int and worker['pid']>0
        and isinstance(worker['birth'],str) and re.fullmatch('[0-9]+',worker['birth'])
        and isinstance(worker['pidNamespace'],str) and re.fullmatch('[0-9]+',worker['pidNamespace']), 'HOST_MODULE_TERMINATION_UNCONFIRMED',409)
    old = p['oldService']
    host.check(all(isinstance(old[k], str) and re.fullmatch('[a-f0-9]{64}', old[k]) for k in ['containerId', 'modelSha256'])
        and re.fullmatch('sha256:[a-f0-9]{64}', old['imageId'])
        and re.fullmatch('[a-f0-9]{40}', old['sourceCommit'])
        and re.fullmatch('sha256:[a-f0-9]{64}', p['target']['imageId'])
        and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}', old['project']), 'HOST_MODULE_TERMINATION_UNCONFIRMED', 409)
    host.check(t['prepareSha256'] == record['prepareSha256'] and t['oldContainerId'] == old['containerId']
        and t['status'] == 'stopped' and t['running'] is False and t['restarting'] is False
        and type(t['pid']) is int and t['pid'] == 0 and type(t['exitCode']) is int,
        'HOST_MODULE_TERMINATION_UNCONFIRMED', 409)
    host.check(host.parse_time(old['startedAt']) <= host.parse_time(p['preparedAt'])
        <= host.parse_time(t['finishedAt']) <= host.parse_time(t['stoppedAt']),
        'HOST_MODULE_TERMINATION_UNCONFIRMED', 409)
    return digest(record)


PROBE = '''import json,os,pathlib,sys
workers=json.load(sys.stdin)
result=[]
for w in workers:
 try: birth=pathlib.Path('/proc/'+str(w['pid'])+'/stat').read_text().rsplit(')',1)[1].split()[19]
 except FileNotFoundError: birth=None
 result.append(birth)
print(json.dumps({'pidNamespace':str(os.stat('/proc/self/ns/pid').st_ino),'sourceCommit':json.loads(pathlib.Path('/app/distribution.json').read_text())['sourceCommit'],'births':result}))
'''
FORMAT = '{"id":{{json .Id}},"image":{{json .Image}},"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}},"status":{{json .State.Status}},"dead":{{json .State.Dead}},"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"pid":{{json .State.Pid}},"exitCode":{{json .State.ExitCode}},"restart":{{json .HostConfig.RestartPolicy.Name}},"pidMode":{{json .HostConfig.PidMode}},"entrypoint":{{json .Config.Entrypoint}},"user":{{json .Config.User}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"mounts":{{json .Mounts}}}'


class Switch:
    def __init__(self, api, updater, project, image, private_name, command=None):
        self.api, self.host, self.updater = api, api.host, updater
        self.project, self.image, self.private_name = project, image, private_name
        self.command = command or self.run
        self.container_id = None

    def run(self, args, data=None):
        result = subprocess.run(['/usr/local/bin/docker', *args], input=data, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=120, check=True)
        self.host.check(len(result.stdout) <= self.host.CATALOG_LIMIT, 'HOST_MODULE_SWITCH_RESPONSE_LIMIT')
        return result.stdout

    def inspect(self, cid):
        return self.host.decode(self.command(['container', 'inspect', '--format', FORMAT, cid]))

    def service(self, record, cid):
        h = self.host
        h.check(record['id'] == cid and record['project'] == self.project and record['service'] == 'module-installer'
            and record['pidMode'] == '' and record['readOnly'] is True and record['privileged'] is False
            and record['entrypoint'] == ['/usr/bin/python3','-I','-B','/app/scripts/module-update-service.py']
            and record['user'] == '0:0',
            'HOST_MODULE_SWITCH_IDENTITY', 409)
        h.check(re.fullmatch('sha256:[a-f0-9]{64}', record['image']) is not None, 'HOST_MODULE_SWITCH_IDENTITY')
        for target, name in [('/srv/bellteam-module-updater', self.project + '-module-updater'), ('/srv/bellteam-private', self.private_name)]:
            found = [m for m in record['mounts'] if m.get('Destination') == target]
            h.check(len(found) == 1 and found[0].get('Type') == 'volume' and found[0].get('Name') == name
                and found[0].get('RW') is True, 'HOST_MODULE_SWITCH_STORAGE', 409)
        h.check(len(record['mounts']) == 3 and all(m.get('Type')=='volume' for m in record['mounts'])
            and any(m.get('Destination')=='/run/bellteam-updater' and m.get('Name')==self.project+'-module-socket' and m.get('RW') is True for m in record['mounts']), 'HOST_MODULE_SWITCH_STORAGE',409)
        # The helper mounts the exact daemon volumes; no Host path or caller bind is accepted.
        for name in [self.project + '-module-updater', self.private_name]:
            volume = h.decode(self.command(['volume', 'inspect', '--format', '{{json .}}', name]))
            h.check(volume.get('Name') == name and volume.get('Driver') == 'local'
                and volume.get('Options') in (None, {}), 'HOST_MODULE_SWITCH_STORAGE', 409)
        return record

    def write(self, installer, path, body):
        installer.write_file(path, canonical(body), 0o600)
        installer.sync_directory(path.parent)

    def log(self, stage, request=None, receipt=None):
        print(json.dumps(dict(code='MODULE_WORKER_SWITCH', stage=stage, requestId=request,
            receiptSha256=receipt,oldContainerId=self.container_id), separators=(',', ':')), flush=True)

    def switch(self):
        h, u = self.host, self.updater
        h.check(re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}', self.project) is not None
            and re.fullmatch('sha256:[a-f0-9]{64}', self.image) is not None
            and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]*', self.private_name) is not None,
            'HOST_MODULE_SWITCH_ARGUMENTS')
        ids = self.command(['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + self.project,
            '--filter', 'label=com.docker.compose.service=module-installer']).decode().split()
        h.check(len(ids) <= 1 and all(re.fullmatch('[a-f0-9]{64}', x) for x in ids), 'HOST_MODULE_SWITCH_IDENTITY', 409)
        operations = u.state / 'operations'
        if not operations.exists():
            h.check(not ids, 'HOST_MODULE_SWITCH_LEDGER_MISSING', 409)
            self.log('not_needed'); return
        pending, original_operations = [], {}
        for path in sorted(operations.iterdir()):
            h.request_id(path.name)
            value = u.read_operation(path.name)
            original_operations[path.name]=hashlib.sha256((path/'operation.json').read_bytes()).hexdigest()
            if value['phase'] in h.TERMINAL: continue
            if (path / 'reconciliation-fence.json').exists():
                u.read_install_reconciliation_fence(dict(requestId=path.name,
                    originalOperationSha256=hashlib.sha256((path/'operation.json').read_bytes()).hexdigest()))
                continue
            h.check(value['phase'] == 'unknown', 'HOST_UPDATE_BUSY', 409)
            pending.append(dict(requestId=path.name, originalOperationSha256=hashlib.sha256((path/'operation.json').read_bytes()).hexdigest()))
        if not ids and not pending: self.log('not_needed'); return
        cid = ids[0] if ids else None; self.container_id=cid
        with contextlib.ExitStack() as locks:
            locks.enter_context(h.locked(u.state/'worker.lock'))
            locks.enter_context(h.locked(u.state/'ledger.lock'))
            h.check(original_operations == {p.name:hashlib.sha256((p/'operation.json').read_bytes()).hexdigest() for p in operations.iterdir()}, 'HOST_MODULE_ORIGINAL_CHANGED',409)
            if not pending:
                self.service(self.inspect(cid),cid)
                self.command(['container','update','--restart','no',cid])
                self.command(['container','stop',cid]);self.command(['container','wait',cid])
                final=self.service(self.inspect(cid),cid)
                h.check(final['status']=='exited' and final['dead'] is False and final['running'] is False and final['restarting'] is False and final['pid']==0 and final['restart']=='no', 'HOST_MODULE_TERMINATION_UNCONFIRMED',409)
                self.command(['container','rm',cid]);self.log('removed');return
            locks.enter_context(self.api.reconciliation_lock(u.private, u.uid, shared=True))
            locks.enter_context(self.api.reconciliation_lock(u.private/'execution/.install.lock', u.uid))
            h.check(not os.path.lexists(u.private/'.transaction.json') and not any(
                x.name.startswith('.staging-') for x in (u.private/'execution').iterdir()), 'HOST_MODULE_UNOWNED_STAGE', 409)
            old = self.service(self.inspect(cid), cid) if cid else None
            origins = [u.reconciliation_origin(p) for p in pending]
            h.check(all(u.inspect_current()['privateVolume']==p['expected']['privateVolume'] for _,_,p,*_ in origins), 'HOST_MODULE_SWITCH_STORAGE',409)
            h.check(all(not os.path.lexists(d/'recovery-claim.json') for d,*_ in origins), 'HOST_MODULE_RECOVERY_UNCONFIRMED', 409)
            if cid is None:
                for d,v,p,ps,_ in origins:
                    receipt_sha=read_termination(u,h,d,v,p,ps)
                    self.container_id=h.read_json(d/'worker-termination.json',u.uid)['prepare']['oldService']['containerId']
                    self.log('already_stopped',v['requestId'],receipt_sha)
                return
            # An interrupted transition may only be read; never repeat stop or issue another prepare.
            existing = [os.path.lexists(d/'worker-termination-prepare.json') for d,*_ in origins]
            if any(existing):
                h.check(all(existing), 'HOST_MODULE_TERMINATION_UNCONFIRMED', 409)
                for d,v,p,ps,_ in origins: read_termination(u,h,d,v,p,ps)
                h.check(old['status']=='exited' and old['dead'] is False and old['running'] is False and old['restarting'] is False and old['pid'] == 0
                    and old['restart'] == 'no', 'HOST_MODULE_TERMINATION_UNCONFIRMED', 409)
                # Do not resolve a service name to a replacement container on retry.
                for d,*_ in origins:
                    record = h.read_json(d/'worker-termination.json',u.uid)
                    h.check(record['prepare']['oldService']['containerId'] == cid, 'HOST_MODULE_SWITCH_IDENTITY',409)
                self.command(['container','rm',cid]); self.log('already_stopped'); return
            h.check(old['status']=='running' and old['dead'] is False and old['running'] is True and old['restarting'] is False, 'HOST_MODULE_WORKER_UNCONFIRMED',409)
            workers = [v['worker'] for _,v,*_ in origins]
            for w in workers:
                h.check(h.exact(w,'pid,birth,pidNamespace') and type(w['pid']) is int and w['pid'] > 0
                    and isinstance(w['birth'],str) and re.fullmatch('[0-9]+',w['birth']), 'HOST_MODULE_WORKER_UNCONFIRMED',409)
            observed = h.decode(self.command(['exec','--interactive','--user','0:0',cid,'/usr/bin/python3','-I','-B','-c',PROBE],canonical(workers)))
            h.check(h.exact(observed,'pidNamespace,sourceCommit,births') and re.fullmatch('[a-f0-9]{40}',observed['sourceCommit'])
                and type(observed['births']) is list and all(b is None or isinstance(b,str) and re.fullmatch('[0-9]+',b) for b in observed['births'])
                and len(observed['births']) == len(workers), 'HOST_MODULE_SWITCH_IDENTITY',409)
            h.check(all(observed['sourceCommit']==p['expected']['sourceCommit'] for _,_,p,*_ in origins), 'HOST_MODULE_SWITCH_IDENTITY',409)
            for w,b in zip(workers,observed['births']):
                h.check(w['pidNamespace'] == observed['pidNamespace'] and (b is None or b != w['birth']), 'HOST_MODULE_WORKER_UNCONFIRMED',409)
            h.check(self.service(self.inspect(cid),cid) == old, 'HOST_MODULE_SWITCH_IDENTITY',409)
            prepared=[]
            for d,v,p,ps,installer in origins:
                body=dict(schema='bellteam.module-worker-prepare.v1',requestId=v['requestId'],planId=p['planId'],
                    originalOperationSha256=hashlib.sha256((d/'operation.json').read_bytes()).hexdigest(),planSha256=ps,
                    targetSha256=digest(p['target']),storageBindingSha256=digest(p['expected']['privateVolume']),
                    ledgerBinding=binding(u.prefix),worker=v['worker'],oldService=dict(containerId=cid,imageId=old['image'],
                        sourceCommit=observed['sourceCommit'],startedAt=old['started'],pidNamespace=observed['pidNamespace'],
                        modelSha256=digest({k:old[k] for k in ['project','service','image','mounts','pidMode','readOnly','privileged','entrypoint','user']}),project=self.project),
                    target=dict(sourceCommit=u.config['release'],imageId=self.image),preparedAt=h.stamp())
                self.write(installer,d/'worker-termination-prepare.json',body);prepared.append((d,body,installer))
                self.log('prepared',v['requestId'],digest(body))
            self.command(['container','update','--restart','no',cid])
            self.command(['container','stop',cid]); self.log('stop_returned')
            wait=self.command(['container','wait',cid]).decode().strip()
            final=self.service(self.inspect(cid),cid)
            h.check(final['id']==old['id'] and final['image']==old['image'] and final['started']==old['started']
                and final['status']=='exited' and final['dead'] is False and final['running'] is False and final['restarting'] is False and final['pid']==0 and final['restart']=='no'
                and re.fullmatch('-?[0-9]+',wait) and int(wait)==final['exitCode'], 'HOST_MODULE_TERMINATION_UNCONFIRMED',409)
            for d,p,installer in prepared:
                t=dict(schema='bellteam.module-worker-termination.v1',requestId=p['requestId'],originalOperationSha256=p['originalOperationSha256'],
                    prepareSha256=digest(p),oldContainerId=cid,status='stopped',running=False,restarting=False,pid=0,
                    finishedAt=final['finished'],exitCode=final['exitCode'],stoppedAt=h.stamp())
                record=dict(prepareSha256=digest(p),prepare=p,terminationSha256=digest(t),termination=t)
                self.write(installer,d/'worker-termination.json',record);self.log('recorded',p['requestId'],digest(record))
            self.command(['container','rm',cid]);self.log('removed')


def read_receipt(api,updater,request):
    request=api.host.request_id(request);directory=updater.state/'operations'/request
    with api.reconciliation_lock(updater.state/'worker.lock',updater.uid), api.reconciliation_lock(updater.state/'ledger.lock',updater.uid):
        _,original=api.reconciliation_json(directory/'operation.json',updater.uid)
        d,v,p,ps,_=updater.reconciliation_origin(dict(requestId=request,originalOperationSha256=original))
        with api.reconciliation_lock(updater.private,updater.uid,shared=True), api.reconciliation_lock(updater.private/'execution/.install.lock',updater.uid):
            receipt_sha=read_termination(updater,api.host,d,v,p,ps)
            record=api.host.read_json(d/'worker-termination.json',updater.uid)
            return dict(code='MODULE_WORKER_TERMINATION_READ',requestId=request,originalOperationSha256=original,oldContainerId=record['prepare']['oldService']['containerId'],worker=v['worker'],receiptSha256=receipt_sha,status='stopped')


def main():
    api=load('termination_module_api','module-update-service.py')
    read_only=len(sys.argv)==3 and sys.argv[1]=='--read'
    api.host.check(read_only or len(sys.argv)==4,'HOST_MODULE_SWITCH_ARGUMENTS')
    api.host.check(os.getuid()==os.geteuid()==0,'HOST_UPDATE_ROOT_REQUIRED')
    os.umask(0o077)
    distribution=api.host.read_json('/app/distribution.json')
    source=distribution.get('sourceCommit')
    api.host.check(distribution.get('schema')=='bellteam.server.distribution.v1' and isinstance(source,str) and re.fullmatch('[a-f0-9]{40}',source), 'HOST_MODULE_SOURCE_INVALID')
    arch={'x86_64':'amd64','aarch64':'arm64'}.get(platform.machine())
    api.host.check(arch is not None and sys.platform=='linux','HOST_MODULE_PLATFORM_UNSUPPORTED')
    api.host.trusted(api.PREFIX,directory=True)
    if not read_only:(api.PREFIX/'state').mkdir(mode=0o700,exist_ok=True)
    api.host.trusted(api.PREFIX/'state',directory=True)
    updater=api.ModuleUpdater(api.PREFIX,api.PRIVATE,dict(release=source,platform=dict(os='linux',arch=arch),python='/usr/bin/python3'))
    if read_only:
        print(json.dumps(read_receipt(api,updater,sys.argv[2]),separators=(',',':')))
        return
    Switch(api,updater,*sys.argv[1:]).switch()


if __name__=='__main__':
    try: main()
    except Exception as error:
        code=getattr(error,'code','HOST_MODULE_TERMINATION_UNCONFIRMED')
        if not isinstance(code,str) or not re.fullmatch('[A-Z_0-9]{1,100}',code):code='HOST_MODULE_TERMINATION_UNCONFIRMED'
        sys.stderr.write(code+'\n');sys.exit(1)
