import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('generation_fixture',ROOT/'test/sec014-control-generation.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
a,c=g.a,g.c
OLD='sha256:'+'a'*64


class RecoveryInputs(g.Generations):
    def inputs(self,layout='legacy'):
        self.target=self.normal('NEW123')
        model=json.loads(self.target.read_bytes())
        bind=lambda source,target:dict(type='bind',source=str(source),target=target)
        self.data=self.root/'data';self.home=self.root/'home'
        self.data.mkdir();self.home.mkdir()
        mounts=[bind(self.data,'/srv/bellteam'),bind(self.home,'/home/bell'),dict(type='volume',source='cursor',target='/home/bell/.local')]
        leaves=['state','rooms','owner','logs','shared/tools/bellteam-settings','shared/tools/apns']
        private=[bind(self.root/'private'/name,'/srv/bellteam/'+name) for name in leaves]
        model['services']['bellteam']['volumes']+=mounts+private
        model['volumes']={'cursor':{'name':'fixture_cursor'}}
        self.target.write_text(json.dumps(model))
        maintenance=dict(services={'state-maintenance':dict(image=g.SELECTED['image'],volumes=[
            bind(self.data,'/srv/bellteam-legacy'),bind(self.data,'/srv/bellteam'),*private,
            bind(self.root/'backups','/srv/bellteam-maintenance-backups')])})
        self.previous=self.root/'.bellteam-compose.OLD123';self.previous.mkdir(mode=0o700)
        self.original=self.previous/'previous-normal.json'
        old=json.loads(json.dumps(model))
        old['services']['bellteam']['image']=OLD
        old['services']['bellteam']['environment']['SECRET']='synthetic-not-in-receipt'
        if layout=='legacy':
            old['services']['bellteam']['volumes']=mounts
            old['services']['bellteam']['environment'].pop('BELLTEAM_NORMAL_ADMISSION_TOKEN')
            old['services']['bellteam']['volumes']=[v for v in mounts if v.get('target')!='/run/bellteam-maintenance']
        self.old_model=old
        self.write(self.original,old)
        self.write(self.previous/'previous-runtime.json',dict(Id='b'*64,Image=OLD,State={'StartedAt':'2026-10-27T16:03:53Z'}))
        self.archive=self.root/'runtime/backups/image-before-deploy.ABC123';self.archive.mkdir(parents=True,mode=0o700)
        self.text(self.archive/'container-image.txt','b'*64+' '+OLD+'\n')
        self.text(self.archive/'container-started-at.txt','2026-10-27T16:03:53Z\n')
        self.text(self.archive/'previous-compose.path',str(self.original)+'\n')
        self.write(self.target.parent/'recovery.json',dict(previousCompose=str(self.original),previousImageArchive=str(self.archive),stateLayout=layout))
        self.write(self.target.parent/'compose.state-maintenance.json',maintenance)
        return self.target

    def write(self,path,value):
        path.write_text(json.dumps(value));path.chmod(0o600)

    def text(self,path,value):
        path.write_text(value);path.chmod(0o600)

    def test_legacy_selects_exact_old_image_without_inventing_token(self):
        normal=self.inputs()
        with self.hold(normal) as tx,patch.object(a.subprocess,'Popen',side_effect=AssertionError('selection cannot execute clients')):
            selected=a._RecoveryInputs(tx,normal.parent)
            self.assertEqual(selected.layout,'legacy')
            self.assertEqual(selected.image,OLD)
            self.assertNotIn('token',selected.selected_normal)
            self.assertEqual(selected.data,str(self.data))
            self.assertEqual(selected.home,str(self.home))
            self.assertNotIn('synthetic-not-in-receipt',json.dumps(selected.value))
            tx.check()
            with self.assertRaisesRegex(c.ControlError,'GENERATION'):c._normal(self.original)

    def test_server_keeps_actual_saved_token_and_private_sources(self):
        normal=self.inputs('server')
        with self.hold(normal) as tx:
            selected=a._RecoveryInputs(tx,normal.parent)
            self.assertEqual(selected.layout,'server')
            self.assertEqual(selected.selected_normal['token'],g.SELECTED['token'])
            self.assertEqual(selected.selected_normal['image'],OLD)
            tx.check()

    def test_server_layout_without_control_keeps_original_runtime(self):
        normal=self.inputs('server')
        self.old_model['services']['bellteam']['environment'].pop('BELLTEAM_NORMAL_ADMISSION_TOKEN')
        self.old_model['services']['bellteam']['volumes']=[v for v in self.old_model['services']['bellteam']['volumes'] if v.get('target')!='/run/bellteam-maintenance']
        self.write(self.original,self.old_model)
        with self.hold(normal) as tx:
            selected=a._RecoveryInputs(tx,normal.parent)
            self.assertEqual(selected.layout,'server')
            self.assertFalse(selected.controlled)
            self.assertNotIn('token',selected.selected_normal)

    def test_partial_saved_control_cannot_gain_runtime_admission(self):
        normal=self.inputs('server')
        self.old_model['services']['bellteam']['environment'].pop('BELLTEAM_NORMAL_ADMISSION_TOKEN')
        self.write(self.original,self.old_model)
        with self.hold(normal) as tx:
            with self.assertRaisesRegex(c.ControlError,'CONTROL_PAIR'):a._RecoveryInputs(tx,normal.parent)

    def test_same_bytes_new_original_inode_refuses_next_transaction_check(self):
        normal=self.inputs()
        with self.hold(normal) as tx:
            a._RecoveryInputs(tx,normal.parent)
            replacement=self.original.with_suffix('.replacement')
            self.text(replacement,self.original.read_text());os.replace(replacement,self.original)
            with self.assertRaisesRegex(c.ControlError,'GENERATION_CHANGED'):tx.check()

    def test_changed_home_or_cursor_refuses_before_native_effect(self):
        for field in ('home','cursor'):
            with self.subTest(field=field):
                fixture=RecoveryInputs();fixture.setUp()
                try:
                    normal=fixture.inputs()
                    if field=='home':fixture.old_model['services']['bellteam']['volumes'][1]['source']+='/other'
                    else:fixture.old_model['volumes']['cursor']['name']='other_cursor'
                    fixture.write(fixture.original,fixture.old_model)
                    with fixture.hold(normal) as tx:
                        with self.assertRaises(c.ControlError):a._RecoveryInputs(tx,normal.parent)
                finally:fixture.doCleanups()

    def test_partial_server_private_mounts_are_not_legacy(self):
        normal=self.inputs('server')
        self.old_model['services']['bellteam']['volumes'].pop()
        self.write(self.original,self.old_model)
        with self.hold(normal) as tx:
            with self.assertRaisesRegex(c.ControlError,'VIEWS'):a._RecoveryInputs(tx,normal.parent)

    def test_image_archive_pair_mismatch_stops_selection(self):
        normal=self.inputs()
        self.text(self.archive/'container-image.txt','c'*64+' '+OLD+'\n')
        with self.hold(normal) as tx:
            with self.assertRaisesRegex(c.ControlError,'ARCHIVE'):a._RecoveryInputs(tx,normal.parent)

    def test_archive_symlink_is_not_an_original(self):
        normal=self.inputs()
        path=self.archive/'container-image.txt';path.rename(path.with_suffix('.original'));path.symlink_to(path.with_suffix('.original'))
        with self.hold(normal) as tx:
            with self.assertRaises(OSError):a._RecoveryInputs(tx,normal.parent)

    def test_readonly_original_profile_is_preserved_and_changes_are_detected(self):
        normal=self.inputs()
        profile=self.previous/'previous-profile.mjs'
        self.text(profile,'export const profile="old"\n');profile.chmod(0o644)
        self.old_model['services']['bellteam']['volumes'].append(dict(type='bind',source=str(profile),target='/app/src/distribution-profile.mjs',read_only=True))
        self.write(self.original,self.old_model)
        with self.hold(normal) as tx:
            a._RecoveryInputs(tx,normal.parent)
            profile.write_text('export const profile="new"\n')
            with self.assertRaisesRegex(c.ControlError,'ARCHIVE_CHANGED'):tx.check()


if __name__=='__main__':
    suite=unittest.TestSuite(RecoveryInputs(name) for name in RecoveryInputs.__dict__ if name.startswith('test_'))
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
