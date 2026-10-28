import importlib.util,json,os
from pathlib import Path
import unittest
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('generation_fixture',ROOT/'test/sec014-control-generation.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Record(m.Generations):
    def pair(self):
        n=self.normal('aaaaaa');p=n.parent/'compose.state-prepare.yaml'
        p.write_text(json.dumps({'name':'bellteam-state-prepare','services':{'state-prepare':{'image':m.SELECTED['image']}}}));p.chmod(0o600)
        return n,p
    def test_record(self):
        n,p=self.pair()
        with self.hold(n) as tx:
            r=tx.value['normal']['prepare']
            self.assertEqual(r['path'],str(p));self.assertEqual(r['inode'],p.stat().st_ino)
            self.assertEqual(r['image'],tx.value['normal']['image']);tx.check()
    def test_replaced_same_bytes(self):
        n,p=self.pair()
        with self.hold(n) as tx:
            replacement=p.with_suffix('.replacement');replacement.write_bytes(p.read_bytes());replacement.chmod(0o600);os.replace(replacement,p)
            with self.assertRaises(m.c.ControlError):tx.check()
    def test_mismatched_raw_image(self):
        n,p=self.pair();x=json.loads(p.read_text());x['services']['state-prepare']['image']='sha256:'+'f'*64;p.write_text(json.dumps(x))
        with self.assertRaises(m.c.ControlError):
            with self.hold(n):pass
    def test_old_generation_without_prepare(self):
        n=self.normal('aaaaaa')
        with self.hold(n) as tx:self.assertNotIn('prepare',tx.value['normal'])
    def test_previous_normal_does_not_bind_current_prepare(self):
        n,p=self.pair();previous=n.with_name('previous-normal.json')
        raw=json.loads(n.read_text());raw['services']['bellteam']['image']='sha256:'+'f'*64
        previous.write_text(json.dumps(raw));previous.chmod(0o600)
        self.assertNotIn('prepare',m.c._normal(previous))
    def test_symlink(self):
        n,p=self.pair();other=p.with_suffix('.copy');p.rename(other);p.symlink_to(other)
        with self.assertRaises(m.c.ControlError):
            with self.hold(n):pass
if __name__=='__main__':
    suite=unittest.TestSuite(Record(x) for x in ['test_record','test_replaced_same_bytes','test_mismatched_raw_image','test_symlink','test_old_generation_without_prepare','test_previous_normal_does_not_bind_current_prepare'])
    r=unittest.TextTestRunner().run(suite);raise SystemExit(not r.wasSuccessful())
