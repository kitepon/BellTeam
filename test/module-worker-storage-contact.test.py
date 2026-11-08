import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('bridge_fixture',ROOT/'test/module-worker-termination.test.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)

class StorageContact(unittest.TestCase):
    setUp=fixture.WorkerBridge.setUp
    command=fixture.WorkerBridge.command
    assert_original_untouched=fixture.WorkerBridge.assert_original_untouched

    def model_command(self):
        normal=dict(name=self.project,services=dict(bellteam=dict(image=self.image,volumes=[
            dict(type='bind',source='/fixture/runtime/data',target='/srv/bellteam'),
            dict(type='bind',source='/fixture/runtime/home',target='/home/bell'),
            dict(type='volume',source='state',target='/run/bellteam-maintenance',read_only=True,volume=dict(nocopy=True))])),
            volumes=dict(state=dict(name='private',external=True)))
        result=subprocess.run(['node',str(ROOT/'scripts/module-update-compose.mjs'),'--termination-helper'],input=json.dumps(normal),text=True,capture_output=True,check=True)
        args=json.loads(result.stdout)['services']['module-worker-termination']['command']
        self.assertEqual(args[:3],[self.project,self.image,'private'])
        self.switch.private_device=args[3]
        self.volume=dict(Name='private',Driver='local',Labels={'com.docker.compose.project':self.project},
            Options=dict(type='none',o='bind',device=args[3]))
        original=self.switch.command
        def command(args,data=None):
            if args[:2]==['volume','inspect'] and args[-1]=='private':
                self.actions.append(args);return json.dumps(self.volume).encode()
            return original(args,data)
        self.switch.command=command

    def test_frozen_model_local_bind_private_completes_bridge_and_receipt(self):
        self.model_command()
        self.switch.switch()
        record=fixture.host.read_json(self.directory/'worker-termination.json',self.updater.uid)
        self.assertEqual(record['prepare']['worker'],self.operation['worker'])
        self.assertEqual(record['termination']['status'],'stopped')
        self.assertEqual(sum(a[:2]==['container','stop'] for a in self.actions),1)
        self.assert_original_untouched()

    def test_storage_boundary_refuses_foreign_device_options_driver_label_mount_before_stop(self):
        self.model_command();valid=copy.deepcopy(self.volume)
        cases=[]
        for key,value in [('Driver','other'),('Labels',{'com.docker.compose.project':'foreign'}),('Labels',None),('Options',dict(type='none',o='bind',device='/foreign/data')),('Options',dict(type='none',o='bind',device=self.switch.private_device,extra='x'))]:
            bad=copy.deepcopy(valid);bad[key]=value;cases.append(bad)
        for bad in cases:
            with self.subTest(volume=bad):
                self.volume=bad
                with self.assertRaises(fixture.host.Failure) as e:self.switch.switch()
                self.assertEqual(e.exception.code,'HOST_MODULE_SWITCH_STORAGE')
        self.volume=valid
        self.old['mounts'].append(dict(Type='bind',Destination='/extra',Source='/host',RW=True))
        with self.assertRaises(fixture.host.Failure):self.switch.switch()
        self.assertFalse(any(a[:2]==['container','stop'] for a in self.actions))
        self.assertFalse((self.directory/'worker-termination-prepare.json').exists())
        self.assert_original_untouched()

    def test_an_extra_volume_mount_such_as_runtime_code_does_not_refuse_the_switch(self):
        self.model_command()
        self.old['mounts'].append(dict(Type='volume',Name='bellteam-runtime-code',Destination='/srv/bellteam/shared/tools/bellteam-runtime',RW=True))
        self.operation['phase']='completed';fixture.host.atomic(self.directory/'operation.json',self.operation)
        self.switch.switch()
        self.assertTrue(any(a[:2]==['container','rm'] for a in self.actions))

    def test_local_bind_no_pending_update_reaches_same_container_removal(self):
        self.model_command()
        self.operation['phase']='completed';fixture.host.atomic(self.directory/'operation.json',self.operation)
        self.switch.switch()
        self.assertTrue(any(a[:2]==['container','rm'] for a in self.actions))
        self.assertFalse((self.directory/'worker-termination-prepare.json').exists())

    def test_engine_private_volume_and_no_pending_switch_keep_existing_path(self):
        self.model_command();self.volume['Options']=None
        self.operation['phase']='completed';fixture.host.atomic(self.directory/'operation.json',self.operation)
        self.switch.switch()
        self.assertTrue(any(a[:2]==['container','rm'] for a in self.actions))
        self.assertFalse((self.directory/'worker-termination-prepare.json').exists())

if __name__=='__main__':unittest.main()
