import importlib.util,json,os,sys,unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
def load(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'test'/file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module
old=load('prepare_fixture','sec014-prepare-executor.py')
generation=load('generation_fixture','sec014-control-generation.py')
p=old.p

class SavedPrepare(old.PrepareTests):
    def setUp(self):
        super().setUp()
        self.g=generation.Generations();self.g.setUp();self.addCleanup(self.g.doCleanups)
        self.f.root=self.g.control
        self.normal=self.g.normal('aaaaaa')
        model=json.loads(self.normal.read_text())
        model['services']['bellteam']['image']=old.IMAGE_ID
        model['x-bellteam-image-ref']=old.IMAGE
        self.normal.write_text(json.dumps(model))
        self.saved=self.normal.parent/'compose.state-prepare.yaml'
        self.model={'name':'bellteam-state-prepare','x-bellteam-image-ref':old.IMAGE,
            'services':{'state-prepare':dict(image=old.IMAGE_ID,pull_policy='never',user='0:0',
                entrypoint=['/usr/bin/env','-i','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','/app/src/server-state-prepare.mjs'],
                command=[],init=True,read_only=True,network_mode='none',cap_drop=['ALL'],cap_add=['CHOWN'],
                security_opt=['no-new-privileges:true'],cpus=1.0,mem_limit='2147483648',memswap_limit='2147483648',pids_limit=512,
                tmpfs=['/tmp:rw,nosuid,nodev,size=64m'],
                volumes=[dict(type='bind',source=str(self.f.state),target='/srv/bellteam-state-parent',bind=dict(create_host_path=False))])}}
        self.write_model()
        self.f.hold=lambda:self.held_image_original(self.g.hold(self.normal))
        def raw():
            with self.assertRaisesRegex(generation.c.ControlError,'BUSY'):
                with self.f.hold():pass
            return p.actor.prepared._read(self.f.state,self.f.owner,self.f.owner)+b'\n'
        proof=patch.object(p.actor.prepared,'read_prepared_proof',side_effect=raw)
        proof.start();self.addCleanup(proof.stop)

    def write_model(self):
        self.saved.write_text(json.dumps(self.model));self.saved.chmod(0o600)

    def inspector(self):
        return dict(super().inspector(),imageRef=old.IMAGE_ID)

    def test_saved_flow_retains_pair_and_executes_the_recorded_generation(self):
        with self.f.hold() as self.tx:
            receipt=self.runner().prepare()
            self.assertEqual(len(self.commands),4)
            argv=self.commands[0][0]
            self.assertEqual(argv[argv.index('-f')+1],str(self.saved))
            self.assertEqual(self.commands[0][1]['BELLTEAM_SERVER_IMAGE'],old.IMAGE_ID)
            claim=json.loads((self.f.root/'to-server-prepare-run.claim.json').read_text())
            self.assertEqual((claim['image'],claim['imageId']),(old.IMAGE,old.IMAGE_ID))
            chain=json.loads((self.f.root/'to-server-prepare-chain.json').read_text())
            self.assertEqual(chain['terminal']['argv'],argv)
            self.assertEqual(receipt['image'],old.IMAGE)
            self.assertEqual(self.journal()['phases'],[])

    def test_extra_mount_is_rejected_before_a_client_is_started(self):
        self.model['services']['state-prepare']['volumes'].append(dict(type='bind',source='/home',target='/home'))
        self.write_model()
        with self.f.hold() as self.tx:
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):self.runner().prepare()
        self.assertEqual(self.commands,[])
        self.assertFalse((self.f.root/'to-server-prepare-evidence.json').exists())

    def test_different_official_ref_cannot_use_the_same_raw_image(self):
        other='ghcr.io/kitepon/bellteam-server@sha256:'+'f'*64
        model=json.loads(self.normal.read_text());model['x-bellteam-image-ref']=other
        self.normal.write_text(json.dumps(model));self.model['x-bellteam-image-ref']=other;self.write_model()
        with self.f.hold() as self.tx:
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):self.runner().prepare()
        self.assertEqual(self.commands,[])

    def test_same_bytes_replacement_before_run_never_starts_a_client(self):
        def replace(step):
            replacement=self.saved.with_suffix('.replacement')
            replacement.write_bytes(self.saved.read_bytes());replacement.chmod(0o600)
            os.replace(replacement,self.saved)
            return 'd'*64
        with self.f.hold() as self.tx:
            with self.assertRaisesRegex(p.actor.control.ControlError,'PHASE_UNCONFIRMED'):self.runner(host=replace).prepare()
        self.assertEqual(self.commands,[])

    def test_old_fixed_argv_is_rejected_before_prepared_metadata(self):
        with self.f.hold() as self.tx,patch.object(p.actor.prepared,'read_prepared_proof') as read:
            with self.assertRaisesRegex(p.actor.control.ControlError,'TERMINAL_UNCONFIRMED'):
                p.actor.prepared_phase_receipt(self.tx,old.IMAGE,self.f.terminal(self.tx),'d'*64)
            read.assert_not_called()
        self.assertFalse((self.f.root/'to-server-prepare-evidence.json').exists())

if __name__=='__main__':
    names=['test_saved_flow_retains_pair_and_executes_the_recorded_generation',
        'test_extra_mount_is_rejected_before_a_client_is_started',
        'test_different_official_ref_cannot_use_the_same_raw_image',
        'test_same_bytes_replacement_before_run_never_starts_a_client',
        'test_old_fixed_argv_is_rejected_before_prepared_metadata']
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(SavedPrepare(n) for n in names))
    raise SystemExit(not result.wasSuccessful())
