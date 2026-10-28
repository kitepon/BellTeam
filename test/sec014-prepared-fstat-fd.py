import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE=Path(__file__).resolve().parents[1]/'distribution/internal/sec014-prepared-proof.py'
spec=importlib.util.spec_from_file_location('prepared_proof_counter',SOURCE)
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

def fds():
    result={}
    for name in os.listdir('/proc/self/fd'):
        try:result[int(name)]=os.readlink('/proc/self/fd/'+name)
        except FileNotFoundError:pass
    return result

class FstatRecovery(unittest.TestCase):
    def test_opened_leaf_closes_when_initial_fstat_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'state-data';root.mkdir(mode=0o700)
            before=root.stat();value={'schema':'bellteam.state-directories.v1','parent':{'device':str(before.st_dev),'inode':str(before.st_ino)},'leaves':[]}
            for name in p.LEAVES:
                leaf=root/name;leaf.mkdir(mode=0o711);info=leaf.stat();value['leaves'].append({'name':name,'device':str(info.st_dev),'inode':str(info.st_ino)})
            receipt=root/'.prepared.json';receipt.write_text(json.dumps(value));receipt.chmod(0o600)
            original=p.os.fstat;hit=[]
            def fail(fd):
                if os.readlink('/proc/self/fd/'+str(fd))==str(root/'state'):
                    hit.append(fd);raise OSError(5,'synthetic leaf fstat EIO')
                return original(fd)
            initial=fds();after={}
            try:
                with patch.object(p.os,'fstat',side_effect=fail):
                    with self.assertRaises(OSError):p._read(root,(os.getuid(),os.getgid()),(os.getuid(),os.getgid()))
                after=fds();leaked={fd:path for fd,path in after.items() if fd not in initial}
                print(json.dumps({'initialFstatFailures':len(hit),'leakedFDs':len(leaked),'leakedLeafNames':[Path(s).name for s in leaked.values()],'actualRoot':False,'Docker':0}),flush=True)
                self.assertEqual(len(hit),1)
                self.assertEqual(leaked,{})
            finally:
                for fd,path in after.items():
                    if fd not in initial and path==str(root/'state'):os.close(fd)

if __name__=='__main__':unittest.main(verbosity=2)
