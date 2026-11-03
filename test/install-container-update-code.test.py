import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('publisher',Path(__file__).resolve().parents[1]/'scripts/install-container-update-code.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
host_spec=importlib.util.spec_from_file_location('host_check',Path(__file__).resolve().parents[1]/'scripts/container-update-host.py')
host=importlib.util.module_from_spec(host_spec);host_spec.loader.exec_module(host)
class CodeTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]);self.addCleanup(self.temp.cleanup)
  self.prefix=Path(self.temp.name);self.addCleanup(self.writable);self.calls=[]
  self.data={path:('fixture '+path).encode()for path in module.PATHS}
  self.manifest={'schema':'bellteam.host-updater.code-manifest.v1','sourceCommit':'a'*40,
   'files':[{'imagePath':path,'installPath':target,'bytes':len(self.data[path]),'sha256':hashlib.sha256(self.data[path]).hexdigest()}for path,target in module.PATHS.items()]}
 def writable(self):
  for root,_,_ in os.walk(self.prefix):os.chmod(root,0o700)
 def command(self,args):
  self.calls.append(args)
  if args[0]=='create':return ('b'*64+'\n').encode()
  if args[0]=='cp':
   source=args[1].split(':',1)[1]
   raw=json.dumps(self.manifest).encode()if source.endswith('root-code-manifest.json')else self.data[source]
   Path(args[2]).write_bytes(raw)
  return b''
 def publish(self):return module.publish('ghcr.io/kitepon/bellteam-server@sha256:'+'c'*64,'a'*40,prefix=self.prefix,uid=os.getuid(),command=self.command)
 def test_complete_fixed_inventory_is_immutable_and_never_starts_the_image(self):
  result=self.publish();self.assertEqual(result['sourceCommit'],'a'*40)
  target=self.prefix/'releases'/('a'*40)
  for path in target.rglob('*'):self.assertEqual(path.stat().st_mode&0o777,0o555 if path.is_dir()else 0o444)
  host.verify_root_release(target,'a'*40,os.getuid())
  modified=target/'scripts/container-update-host.py';modified.chmod(0o644);modified.write_bytes(b'changed')
  with self.assertRaises(host.Failure):host.verify_root_release(target,'a'*40,os.getuid())
  self.assertFalse(any(call[0]in {'run','start','exec'}for call in self.calls))
  self.assertEqual(self.calls[-1],['rm','b'*64])
  with self.assertRaises(ValueError):self.publish()
 def test_path_injection_incomplete_and_changed_bytes_are_rejected_with_container_cleanup(self):
  for mutation in ['path','missing','bytes']:
   original=json.loads(json.dumps(self.manifest))
   if mutation=='path':self.manifest['files'][0]['installPath']='../escape'
   if mutation=='missing':self.manifest['files'].pop()
   if mutation=='bytes':self.manifest['files'][0]['sha256']='f'*64
   with self.assertRaises(ValueError):self.publish()
   self.assertFalse((self.prefix/'releases'/('a'*40)).exists())
   self.assertEqual(self.calls[-1],['rm','b'*64]);self.manifest=original
if __name__=='__main__':unittest.main()
