import datetime as dt
from concurrent.futures import ThreadPoolExecutor, TimeoutError
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('host_updater',Path(__file__).resolve().parents[1]/'scripts/container-update-host.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class HostTest(unittest.TestCase):
    def setUp(self):
        # Root ownership is substituted with current UID; no root/systemd/Docker claim.
        self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]);self.addCleanup(self.temp.cleanup)
        self.prefix=Path(self.temp.name);(self.prefix/'state').mkdir(mode=0o700);(self.prefix/'catalog').mkdir()
        self.current={'containerId':'a'*64,'imageId':'sha256:'+'b'*64,'sourceCommit':'c'*40,'health':'healthy','imageRef':None}
        self.calls=[];self.threads=[];self.release=threading.Event();self.release.set()
        self.config={'platform':{'os':'linux','arch':'amd64'},'projectName':'bellteam'}
        self.updater=module.HostUpdater(self.prefix,self.config,uid=os.getuid(),inspect=lambda:dict(self.current),launcher=self.launch,execute=self.execute)
        self.updater.assert_model_binding=lambda *args:None
        self.catalog=self.make_catalog();self.install_catalog(self.catalog)
        self.addCleanup(self.writable);self.addCleanup(self.join)
    def writable(self):
        for root,_,_ in os.walk(self.prefix):os.chmod(root,0o700)
    def join(self):
        self.release.set()
        for thread in self.threads:thread.join(3);self.assertFalse(thread.is_alive())
    def make_catalog(self, seconds=-60, revoked=None):
        now=dt.datetime.now(dt.timezone.utc)
        return {'schema':'bellteam.update-catalog.v1','publishedAt':(now+dt.timedelta(seconds=seconds)).isoformat(),
          'expiresAt':(now+dt.timedelta(days=1)).isoformat(),'revokedCatalogs':revoked or [],'releases':[
          {'componentId':'container','sourceCommit':'d'*40,'versionId':'sha256:'+'e'*64,'platform':self.config['platform'],
           'artifact':{'kind':'oci-index','reference':'ghcr.io/kitepon/bellteam-server@sha256:'+'e'*64},
           'compatibility':{'nodeMajor':26,'parentProtocol':None,'stateSchema':None,'containerUpdate':1},'changes':['Update']} ]}
    def install_catalog(self,catalog):
        raw=json.dumps(catalog).encode();identifier=hashlib.sha256(raw).hexdigest()
        receipt={'schema':'bellteam.update-catalog.verification.v1','catalogSha256':identifier,'catalog':catalog,
         'verification':{'method':'github-oidc-attestation','repositoryId':'1404510084','sourceCommit':'f'*40,'signerCommit':'f'*40,
          'signerWorkflow':'kitepon/BellTeam/.github/workflows/publish-update-catalog.yml'}}
        result=module.accept_catalog(self.updater,raw,receipt);self.digest=result;return result
    def plan(self):
        return self.updater.plan({'planId':str(uuid.uuid4()),'catalogSha256':self.digest,'versionId':'sha256:'+'e'*64})
    def launch(self,identifier):
        self.calls.append(identifier)
        thread=threading.Thread(target=lambda:self.updater.worker(identifier));thread.start();self.threads.append(thread)
    def execute(self,plan,directory):
        self.updater.progress(directory,'verifying')
        self.release.wait(3)
        self.updater.progress(directory,'swapping')
        return {'execution':'succeeded','verification':'succeeded','cleanup':'failed','rollback':'not_needed','observed':self.current,
                'error':'HOST_UPDATE_CLEANUP_FAILED'}
    def test_durable_acceptance_duplicate_same_id_and_separate_completion(self):
        self.release.clear();plan=self.plan();identifier=str(uuid.uuid4())
        args={'requestId':identifier,'planId':plan['planId'],'confirmContainerRestart':True}
        accepted=self.updater.start(args);self.assertEqual(accepted['admission'],'accepted')
        self.assertEqual(self.updater.start(args)['requestId'],identifier);self.assertEqual(self.calls,[identifier])
        with self.assertRaises(module.Failure) as error:self.updater.start({**args,'planId':str(uuid.uuid4())})
        self.assertEqual(error.exception.status,409)
        # New frontend instance sees the same worker/ledger; no reissue on reconnect.
        reconnected=module.HostUpdater(self.prefix,self.config,uid=os.getuid(),inspect=lambda:dict(self.current),launcher=self.launch)
        self.assertEqual(reconnected.get(identifier)['admission'],'accepted')
        self.release.set();self.join()
        result=reconnected.get(identifier);self.assertEqual(result['phase'],'completed');self.assertEqual(result['cleanup'],'failed')
        self.assertNotIn('worker',result)
        with self.assertRaises(FileExistsError):self.updater.worker(identifier)
    def test_restart_confirmation_current_binding_and_parallel_operation(self):
        plan=self.plan();args={'requestId':str(uuid.uuid4()),'planId':plan['planId'],'confirmContainerRestart':False}
        with self.assertRaises(module.Failure):self.updater.start(args)
        self.current['containerId']='b'*64
        with self.assertRaises(module.Failure):self.updater.start({**args,'confirmContainerRestart':True})
        self.current['containerId']='a'*64;self.release.clear()
        self.updater.start({**args,'confirmContainerRestart':True})
        with self.assertRaises(module.Failure) as error:self.updater.start({**args,'requestId':str(uuid.uuid4()),'confirmContainerRestart':True})
        self.assertEqual(error.exception.code,'HOST_UPDATE_IN_PROGRESS')
    def test_handoff_failure_is_durable_and_never_relaunches(self):
        plan=self.plan();identifier=str(uuid.uuid4());calls=[]
        def lost(request):calls.append(request);raise OSError()
        self.updater.launcher=lost
        args={'requestId':identifier,'planId':plan['planId'],'confirmContainerRestart':True}
        for _ in range(2):
            result=self.updater.start(args)
            self.assertEqual(result['state'],'failed')
            self.assertEqual(result['reason']['code'],'HOST_UPDATE_HANDOFF_FAILED')
        self.assertEqual(calls,[identifier])
    def test_check_catalog_returns_the_record_even_on_failure_and_serializes_refreshes(self):
        frame=lambda params:{'operation':'checkCatalog','params':params}
        with patch.object(module,'_refresh_catalog',return_value=self.digest):
            record=self.updater.dispatch(frame({}))
        self.assertEqual((record['status'],record['error']),('verified',None))
        with patch.object(module,'_refresh_catalog',side_effect=OSError('offline')):
            record=self.updater.dispatch(frame({}))
        self.assertEqual((record['status'],record['error']),('failed','HOST_UPDATE_PUBLICATION_UNCONFIRMED'))
        with self.assertRaises(module.Failure):self.updater.dispatch(frame({'force':True}))
        running=[];overlap=[]
        def fetch(_):
            running.append(1);overlap.append(len(running));threading.Event().wait(0.05);running.pop();return self.digest
        with patch.object(module,'_refresh_catalog',fetch),ThreadPoolExecutor(3) as pool:
            for result in [pool.submit(self.updater.dispatch,frame({})) for _ in range(3)]:self.assertEqual(result.result(5)['status'],'verified')
        self.assertEqual(max(overlap),1)
    def test_catalog_monotonic_replay_expiry_and_durable_revocation(self):
        first=self.digest
        self.assertEqual(self.install_catalog(self.catalog),first)
        other=dict(self.catalog,revokedCatalogs=['a'*64])
        with self.assertRaises(module.Failure):self.install_catalog(other)
        with self.assertRaises(module.Failure):self.install_catalog(self.make_catalog(-120))
        self.install_catalog(self.make_catalog(-30,['a'*64]))
        self.install_catalog(self.make_catalog(-10,[]))
        state=module.read_json(self.prefix/'catalog/state.json',os.getuid(),module.CATALOG_LIMIT)
        self.assertIn('a'*64,state['revokedCatalogs'])
        with patch.object(module.time,'time',return_value=module.time.time()+2*86400):
            self.assertFalse(self.updater.capabilities()['supported'])
        with patch.object(module.time,'time',return_value=module.time.time()-600):
            self.assertFalse(self.updater.capabilities()['supported'])
    def test_lost_worker_is_failed_and_get_never_launches(self):
        self.release.clear();plan=self.plan();identifier=str(uuid.uuid4())
        self.updater.start({'requestId':identifier,'planId':plan['planId'],'confirmContainerRestart':True})
        path=self.prefix/'state/operations'/identifier/'operation.json'
        value=module.read_json(path,os.getuid())
        until=module.time.monotonic()+2
        while value['worker'] is None and module.time.monotonic()<until:
            threading.Event().wait(.001);value=module.read_json(path,os.getuid())
        self.assertIsNotNone(value['worker'])
        value['worker']['pid']=99999999
        module.atomic(path,value)
        result=self.updater.get(identifier)
        self.assertEqual(result['phase'],'failed');self.assertEqual(result['execution'],'failed')
        self.assertEqual(self.calls,[identifier])
    def test_get_waits_for_ledger_writer_and_reads_its_completed_record(self):
        identifier=str(uuid.uuid4());directory=self.prefix/'state/operations'/identifier
        directory.mkdir(mode=0o700);path=directory/'operation.json'
        value={'requestId':identifier,'planId':str(uuid.uuid4()),'target':{},'admission':'accepted',
               'phase':'applying','execution':'pending','verification':'pending','error':None,
               'cleanup':'pending','rollback':'not_needed','observed':None,'updatedAt':module.stamp(),
               'worker':{'pid':99999999,'birth':'missing'}}
        module.atomic(path,value)
        module.atomic(self.prefix/'state/jobs'/(identifier+'.json'),dict(schema='bellteam.update-job.v1',jobId=identifier,idempotencyKey=identifier,kind='container',target=dict(catalogSha256='a'*64,moduleId='container',versionId='b'*64),state='queued',reason=None,transitions=[dict(state='queued',atNs=(now:=str(module.time.time_ns())))],updatedAtNs=now))
        entered=threading.Event();actual_locked=module.locked
        def entering_lock(*args,**kwargs):
            entered.set();return actual_locked(*args,**kwargs)
        with ThreadPoolExecutor(max_workers=1) as pool:
            with actual_locked(self.prefix/'state/ledger.lock'):
                with patch.object(module,'locked',side_effect=entering_lock):
                    result=pool.submit(self.updater.get,identifier)
                    self.assertTrue(entered.wait(1))
                    with self.assertRaises(TimeoutError):result.result(timeout=0.05)
                    value.update(phase='completed',execution='succeeded',verification='succeeded',cleanup='succeeded')
                    module.atomic(path,value)
                    job=self.updater.read_job(identifier);job.update(state='ready',updatedAtNs=job['transitions'][0]['atNs']);job['transitions']=[dict(state='ready',atNs=job['updatedAtNs'])]
                    module.atomic(self.prefix/'state/jobs'/(identifier+'.json'),job)
            observed=result.result(timeout=1)
        self.assertEqual(observed['requestId'],identifier)
        self.assertEqual(observed['phase'],'completed')
        self.assertIsNone(observed['error'])
        self.assertEqual(module.read_json(path,os.getuid())['phase'],'completed')
        self.assertEqual(self.calls,[])
    def executor_fixture(self, fail=False):
        import subprocess
        release=self.prefix/'releases'/('a'*40);(release/'scripts').mkdir(parents=True)
        installation=self.prefix/'installation';installation.mkdir()
        install=self.prefix/'install';install.mkdir()
        self.updater.config.update(release='a'*40,installRoot=str(install),shell='/bin/sh',docker='/usr/bin/docker',python='/usr/bin/python3')
        module.atomic(installation/'normal.json',{'name':'bellteam','services':{'bellteam':{'image':self.current['imageId']}}})
        (release/'scripts/cleanup-deploy-images.py').write_text('# fixture cleanup subprocess is mocked\n')
        script="""#!/bin/sh
set -eu
test -z "${LEAK_NOT_ALLOWED:-}"
saved="$BELLTEAM_INSTALL_DIR/.bellteam-compose.ABC123"
mkdir -p "$saved"
if [ "$1" = --recover ]; then touch "$BELLTEAM_INSTALL_DIR/recovered"; exit 0; fi
cp "$COMPOSE_FILE" "$saved/normal.json"
cp "$BELLTEAM_PREVIOUS_COMPOSE" "$saved/previous-normal.json"
cp "$(dirname "$BELLTEAM_PREVIOUS_COMPOSE")/previous-runtime.json" "$saved/previous-runtime.json"
printf 'saved-compose=%s\\n' "$saved"
[ ! -f "$BELLTEAM_INSTALL_DIR/fail" ] || exit 3
touch "$BELLTEAM_INSTALL_DIR/applied"
"""
        (release/'install.sh').write_text(script)
        if fail:(install/'fail').touch()
        selected='sha256:'+'f'*64
        def command(args,**options):
            if args[0]==self.updater.config['docker']:
                return selected.encode() if args[1:3]==['image','inspect'] else b''
            raise subprocess.CalledProcessError(1,args)
        self.updater.command=command
        self.updater.progress=lambda *_:None
        self.updater.inspect_current=lambda:dict(self.current) if (install/'recovered').exists() or not (install/'applied').exists() else {
            **self.current,'imageId':selected,'sourceCommit':'d'*40,'containerId':'f'*64}
        return install
    def test_installer_subprocess_cleanup_failure_does_not_rollback_healthy_new_runtime(self):
        install=self.executor_fixture()
        plan=self.plan();directory=self.prefix/'state/fixture-result';directory.mkdir()
        with patch.dict(os.environ,{'LEAK_NOT_ALLOWED':'secret'}):result=module.execute_installer(self.updater,plan,directory)
        self.assertEqual(result['verification'],'succeeded');self.assertEqual(result['cleanup'],'failed')
        self.assertEqual(result['rollback'],'not_needed');self.assertFalse((install/'recovered').exists())
        self.assertEqual(module.read_json(self.prefix/'state/current-runtime.json',os.getuid())['sourceCommit'],'d'*40)
    def test_installer_failure_uses_existing_recover_and_verifies_old_image_source(self):
        install=self.executor_fixture(fail=True)
        plan=self.plan();directory=self.prefix/'state/fixture-result';directory.mkdir()
        result=module.execute_installer(self.updater,plan,directory)
        self.assertEqual(result['execution'],'failed');self.assertEqual(result['verification'],'failed')
        self.assertEqual(result['rollback'],'succeeded');self.assertTrue((install/'recovered').exists())
    def test_separate_process_worker_survives_frontend_recreation_and_returns_same_request(self):
        import subprocess,sys
        code=self.prefix/'fixture-worker.py'
        code.write_text("import importlib.util,sys,os,time\nfrom pathlib import Path\n"+
          "s=importlib.util.spec_from_file_location('worker',"+repr(str(Path(module.__file__)))+");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n"+
          "p=Path(sys.argv[1]);config="+repr(self.config)+"\n"+
          "def execute(plan,directory):\n u.progress(directory,'verifying')\n while not (p/'release-worker').exists():time.sleep(.01)\n u.progress(directory,'swapping')\n return dict(execution='succeeded',verification='succeeded',cleanup='succeeded',rollback='not_needed',observed=None,error=None)\n"+
          "u=m.HostUpdater(p,config,uid=os.getuid(),inspect=lambda:"+repr(self.current)+",execute=execute);u.assert_model_binding=lambda *args:None;u.worker(sys.argv[2])\n")
        processes=[]
        def launch(identifier):processes.append(subprocess.Popen([sys.executable,'-I',str(code),str(self.prefix),identifier],start_new_session=True))
        self.updater.launcher=launch
        identifier=str(uuid.uuid4());plan=self.plan()
        try:
            accepted=self.updater.start({'requestId':identifier,'planId':plan['planId'],'confirmContainerRestart':True})
            self.assertEqual(accepted['admission'],'accepted')
            replacement=module.HostUpdater(self.prefix,self.config,uid=os.getuid(),inspect=lambda:self.current)
            self.assertEqual(replacement.get(identifier)['requestId'],identifier)
            (self.prefix/'release-worker').touch();self.assertEqual(processes[0].wait(timeout=3),0)
            self.assertEqual(replacement.get(identifier)['phase'],'completed')
            self.assertNotEqual(processes[0].pid,os.getpid())
        finally:
            for process in processes:
                if process.poll() is None:process.kill();process.wait()
    def test_verified_new_catalog_without_activation_blocks_plans_until_commit_repair(self):
        candidate=self.make_catalog(-20,['a'*64])
        original=module.atomic
        def fail_state(path,value,limit=module.LIMIT):
            if Path(path)==self.prefix/'catalog/state.json':raise OSError('simulated disk failure')
            return original(path,value,limit)
        with patch.object(module,'atomic',side_effect=fail_state):
            with self.assertRaises(OSError):self.install_catalog(candidate)
        self.assertFalse(self.updater.capabilities()['supported'])
        self.install_catalog(candidate)
        self.assertTrue(self.updater.capabilities()['supported'])
    def test_current_storage_model_must_match_actual_bind_volume_and_subpath(self):
        normal={'services':{'bellteam':{'volumes':[{'type':'bind','source':'/fixed/data','target':'/srv/bellteam'},
          {'type':'volume','source':'state','target':'/srv/bellteam/state','volume':{'nocopy':True,'subpath':'state'}}]}},'volumes':{'state':{'name':'fixed-state'}}}
        mounts=[{'Type':'bind','Source':'/fixed/data','Destination':'/srv/bellteam','RW':True},
          {'Type':'volume','Name':'fixed-state','Destination':'/srv/bellteam/state','RW':True}]
        specs=[{'Source':'fixed-state','Target':'/srv/bellteam/state','ReadOnly':False,'VolumeOptions':{'NoCopy':True,'Subpath':'state'}}]
        module.verify_model_mounts(normal,mounts,specs)
        mounts[0]['Source']='/foreign/data'
        with self.assertRaises(module.Failure):module.verify_model_mounts(normal,mounts,specs)
        mounts[0]['Source']='/fixed/data';specs[0]['VolumeOptions']['Subpath']='rooms'
        with self.assertRaises(module.Failure):module.verify_model_mounts(normal,mounts,specs)
    def test_verifier_isolated_sibling_import_and_publisher_argv(self):
        import sys
        scripts=self.prefix/'releases'/('a'*40)/'scripts';scripts.mkdir(parents=True)
        (scripts/'fixture_receipt.py').write_text('marker=True\n')
        catalog_path=self.prefix/'unsigned.json';catalog_path.write_text(json.dumps(self.make_catalog(seconds=-30)))
        bundle=self.prefix/'unsigned.bundle';bundle.write_text('{}')
        (scripts/'verify-update-catalog.py').write_text(
          "import fixture_receipt,sys,json,hashlib\nfrom pathlib import Path\n"
          "assert fixture_receipt.marker and sys.flags.isolated and sys.argv[1]=='--publisher'\n"
          "raw=Path(sys.argv[2]).read_bytes();value=json.loads(raw)\n"
          "print(json.dumps(dict(schema='bellteam.update-catalog.verification.v1',catalogSha256=hashlib.sha256(raw).hexdigest(),catalog=value,verification=dict(method='github-oidc-attestation',repositoryId='1404510084',sourceCommit='f'*40,signerCommit='f'*40,signerWorkflow='kitepon/BellTeam/.github/workflows/publish-update-catalog.yml'))))\n")
        self.updater.config.update(release='a'*40,python=sys.executable)
        result=module.verify_and_install_catalog(self.updater,catalog_path,bundle)
        self.assertEqual(result,hashlib.sha256(catalog_path.read_bytes()).hexdigest())

    def test_members_catalog_selection_keeps_exact_state_compatibility(self):
        catalog=self.make_catalog(seconds=-30)
        state=dict(botProfileSchema='bellteam.bot.v8',scheduleSchema='bellteam.schedule.v1',ownerProfileSchema='bellteam.owner-profile.v1',deletionReceiptSchema='bellteam.bot-deletion.v1',userRulesEncoding='utf8',initializedMarker='.initialized')
        url='https://github.com/kitepon/BellTeam/releases/download/updates-20261103T000000Z/members-'+('b'*40)+'-linux-amd64.tar.gz'
        release=dict(componentId='members',sourceCommit='b'*40,versionId='f'*64,platform=self.config['platform'],changes=[],
          compatibility=dict(nodeMajor=26,parentProtocol=1,stateSchema=None,containerUpdate=None,stateCompatibility=state),
          artifact=dict(kind='archive',archive=dict(url=url,sha256='f'*64,bytes=42),bundle=dict(url=url+'.sigstore.json',sha256='a'*64,bytes=24),signerCommit='c'*40))
        catalog['releases'].append(release);self.install_catalog(catalog)
        selected=self.updater.dispatch(dict(operation='catalog',params=dict(componentId='members')))
        self.assertEqual(selected['release'],release)
        with self.assertRaises(module.Failure):self.updater.dispatch(dict(operation='catalog',params=dict(componentId='arbitrary')))

    def runtime_catalog(self, compatibility=None):
        catalog=self.make_catalog(seconds=-30)
        url='https://github.com/kitepon/BellTeam/releases/download/updates-20261108T000000Z/runtime-codex-'+('b'*40)+'-linux-amd64.tar.gz'
        release=dict(componentId='runtime-codex',sourceCommit='b'*40,versionId='f'*64,platform=self.config['platform'],changes=[],
          compatibility=compatibility or dict(runtimeProtocol=1,nodeMajor=26,libc='glibc'),
          artifact=dict(kind='archive',archive=dict(url=url,sha256='f'*64,bytes=42),bundle=dict(url=url+'.sigstore.json',sha256='a'*64,bytes=24),signerCommit='c'*40))
        self.install_catalog(catalog)
        runtime={'schema':'bellteam.runtime-catalog.v1','catalogSha256':self.digest,'releases':[release]}
        raw=json.dumps(runtime).encode()
        receipt={'schema':'bellteam.runtime-catalog.verification.v1','runtimeCatalogSha256':hashlib.sha256(raw).hexdigest(),'runtimeCatalog':runtime,
         'verification':{'method':'github-oidc-attestation','repositoryId':'1404510084','sourceCommit':'f'*40,'signerCommit':'f'*40,
          'signerWorkflow':'kitepon/BellTeam/.github/workflows/publish-update-catalog.yml'}}
        module.accept_runtime_catalog(self.updater,raw,receipt,self.digest);return release

    def test_runtime_catalog_is_bound_to_its_main_catalog_and_released_readers_never_see_runtime_rows(self):
        release=self.runtime_catalog()
        self.assertNotIn('runtime-codex',[row['componentId'] for row in self.updater.catalog(self.digest)['releases']])
        self.assertEqual(self.updater.dispatch(dict(operation='catalog',params=dict(componentId='runtime-codex')))['release'],release)
        raw=json.dumps({'schema':'bellteam.runtime-catalog.v1','catalogSha256':'0'*64,'releases':[]}).encode()
        with self.assertRaises(module.Failure):
            module.accept_runtime_catalog(self.updater,raw,{'schema':'bellteam.runtime-catalog.verification.v1','runtimeCatalogSha256':hashlib.sha256(raw).hexdigest(),
              'runtimeCatalog':json.loads(raw),'verification':{}},self.digest)

    def test_runtime_job_is_restart_free_and_ready_after_its_own_commit(self):
        release=self.runtime_catalog()
        plan=self.updater.plan({'planId':str(uuid.uuid4()),'catalogSha256':self.digest,'componentId':'runtime-codex','versionId':'f'*64})
        self.assertEqual((plan['target'],plan['impact']),(release,{'containerRestart':False}))
        with self.assertRaises(module.Failure):
            self.updater.start({'requestId':str(uuid.uuid4()),'planId':plan['planId'],'confirmContainerRestart':True})
        request=str(uuid.uuid4())
        self.updater.start({'requestId':request,'planId':plan['planId'],'confirmContainerRestart':False});self.join()
        job=self.updater.job(request)
        self.assertEqual((job['kind'],job['target']['moduleId'],job['state']),('runtime','runtime-codex','ready'))
        self.assertEqual([row['state'] for row in job['transitions']],['queued','downloading','verifying','swapping','ready'])
        self.assertEqual(module.read_json(self.prefix/'state/runtime-current.json',os.getuid())['current'],request)
        with self.assertRaises(module.Failure):
            self.updater.admit_job({'jobId':str(uuid.uuid4()),'idempotencyKey':'k','kind':'module','target':{'catalogSha256':self.digest,'moduleId':'runtime-codex','versionId':'f'*64}})

    def test_parent_closes_only_a_runtime_job_the_worker_never_accepted(self):
        self.runtime_catalog()
        reason={'code':'UPDATE_PARENT_INTERRUPTED','message':'m'}
        job=str(uuid.uuid4())
        self.updater.admit_job({'jobId':job,'idempotencyKey':'k','kind':'runtime','target':{'catalogSha256':self.digest,'moduleId':'runtime-codex','versionId':'f'*64}})
        self.assertEqual(self.updater.update_job({'jobId':job,'state':'failed','reason':reason})['state'],'failed')
        plan=self.updater.plan({'planId':str(uuid.uuid4()),'catalogSha256':self.digest,'componentId':'runtime-codex','versionId':'f'*64})
        request=str(uuid.uuid4())
        self.updater.start({'requestId':request,'planId':plan['planId'],'confirmContainerRestart':False});self.join()
        with self.assertRaises(module.Failure):self.updater.update_job({'jobId':request,'state':'failed','reason':reason})

    def test_runtime_aiterm_mcp_is_refused_before_any_staging(self):
        self.runtime_catalog()
        with self.assertRaises(module.Failure) as refused:
            self.updater.plan({'planId':str(uuid.uuid4()),'catalogSha256':self.digest,'componentId':'runtime-aiterm-mcp','versionId':'f'*64})
        self.assertEqual((refused.exception.code,refused.exception.status),('RUNTIME_COHABITATION_UNSUPPORTED',409))

    def test_runtime_rows_need_the_exact_runtime_contract(self):
        self.runtime_catalog(dict(runtimeProtocol=2,nodeMajor=26,libc='glibc'))
        with self.assertRaises(module.Failure):
            self.updater.plan({'planId':str(uuid.uuid4()),'catalogSha256':self.digest,'componentId':'runtime-codex','versionId':'f'*64})
        module.atomic(self.prefix/'catalog/runtime'/(self.digest+'.json'),{'schema':'bellteam.runtime-catalog.verification.v1'})
        with self.assertRaises(module.Failure) as error:module.runtime_rows(self.updater,self.digest)
        self.assertEqual(error.exception.code,'HOST_UPDATE_CATALOG_UNTRUSTED')

    def test_lost_runtime_worker_in_swapping_completes_only_if_its_generation_was_committed(self):
        self.runtime_catalog()
        for committed,expected in [(True,'ready'),(False,'failed')]:
            plan=self.updater.plan({'planId':str(uuid.uuid4()),'catalogSha256':self.digest,'componentId':'runtime-codex','versionId':'f'*64})
            request=str(uuid.uuid4())
            self.updater.launcher=lambda identifier:None
            self.updater.start({'requestId':request,'planId':plan['planId'],'confirmContainerRestart':False})
            directory=self.prefix/'state/operations'/request
            with module.locked(self.prefix/'state/ledger.lock',wait=True):
                for state in ['downloading','verifying','swapping']:self.updater.set_job(request,state)
                value=module.read_json(directory/'operation.json',os.getuid());value.update(worker={'pid':1,'birth':'gone'},phase='applying')
                module.atomic(directory/'operation.json',value)
            self.updater.runtime_committed=lambda identifier,c=committed:c
            self.assertEqual(self.updater.job(request)['state'],expected)

    def test_argument_and_root_path_boundaries(self):
        for value in [None, [], {}, 1]:
            with self.assertRaises(module.Failure) as error:
                self.updater.dispatch({'operation':'catalog','params':{'componentId':value}})
            self.assertEqual(error.exception.status,400)
        for raw in [b'{"a":NaN}',b'{"a":Infinity}']:
            with self.assertRaises(module.Failure):module.decode(raw)
        for frame in [{'operation':'shell','params':{}},{'operation':'start','params':{'path':'/tmp/x'}},{'operation':'capabilities','params':{},'env':{}}]:
            with self.assertRaises(module.Failure):self.updater.dispatch(frame)
        with self.assertRaises(module.Failure):module.decode(b'{"x":1,"x":2}')
        with self.assertRaises(module.Failure):self.updater.plan({'planId':str(uuid.uuid4()),'catalogSha256':self.digest,'versionId':'latest'})
        path=self.prefix/'catalog/state.json';path.unlink();path.symlink_to(self.prefix/'missing')
        with self.assertRaises(module.Failure):module.read_json(path,os.getuid())

if __name__=='__main__':unittest.main()
