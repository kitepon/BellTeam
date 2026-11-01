import importlib.util
import os
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]
script=Path(os.environ.get('SEC014_PREFLIGHT_SOURCE',str(ROOT/'scripts/deploy-image.sh'))).read_text()
program=script.split("<<'PYACTOR'\n",1)[1].split('\nPYACTOR',1)[0]


class ReachedActor(Exception):
    pass


class QuietPreflight(unittest.TestCase):
    def check(self,helper,owner=0,mode=0o644):
        # Simulated installed metadata only: no root process/Host mutation.
        root=Path('/installed/BellTeam')
        def metadata(path,*args,**kwargs):
            file=path.suffix in ('.sh','.mjs','.py','.yaml','.json') or path.name in ('node','docker','python3','docker-compose')
            return SimpleNamespace(st_uid=owner if path==root/helper else 0,
                st_mode=(stat.S_IFREG|(mode if path==root/helper else 0o644)) if file else stat.S_IFDIR|0o755)
        with patch.object(sys,'argv',['-',str(root),str(root/'.bellteam-compose.ABC123/normal.json'),'c'*64,'preflight']), \
                patch.multiple(os,getuid=lambda:0,geteuid=lambda:0,getgid=lambda:0,getegid=lambda:0), \
                patch.object(Path,'resolve',lambda path,*a,**kw:path), \
                patch.object(Path,'stat',metadata),patch.object(Path,'exists',lambda path:path==Path('/usr/lib/docker/cli-plugins/docker-compose')), \
                patch('shutil.which',return_value='/usr/bin/node'), \
                patch.object(importlib.util,'spec_from_file_location',side_effect=ReachedActor) as load:
            if owner==0 and mode==0o644:
                with self.assertRaises(ReachedActor):exec(compile(program,'canonical-bootstrap','exec'),{})
                load.assert_called_once()
            else:
                with self.assertRaisesRegex(RuntimeError,'TRUST_NOT_INSTALLED'):
                    exec(compile(program,'canonical-bootstrap','exec'),{})
                load.assert_not_called()

    def test_current_helpers_refuse_nonroot_owner_before_import_or_quiet(self):
        for name in ('scripts/check-deploy-quiet.sh','scripts/check-deploy-quiet.mjs'):
            with self.subTest(name=name):self.check(name,owner=1000)

    def test_current_helpers_refuse_writable_mode_before_import_or_quiet(self):
        for name in ('scripts/check-deploy-quiet.sh','scripts/check-deploy-quiet.mjs'):
            with self.subTest(name=name):self.check(name,mode=0o666)

    def test_root_readonly_helper_fixture_reaches_actor_loader(self):
        self.check('scripts/check-deploy-quiet.sh')


if __name__=='__main__':unittest.main(verbosity=2)
