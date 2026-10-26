import os
import json
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
import unittest
from run import BRANCH, SOURCE, ROOT, clean_env, full_argv, require_identity, tap_totals, temporary_directory

class Contracts(unittest.TestCase):
    def test_dispatch_identity(self):
        env = {'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':BRANCH,
               'GITHUB_RUN_ATTEMPT':'1','CI_RUNNER_ENVIRONMENT':'github-hosted'}
        require_identity(env)
        for key, value in [('GITHUB_EVENT_NAME','push'),('GITHUB_REF','refs/heads/main'),
                           ('GITHUB_RUN_ATTEMPT','2'),('CI_RUNNER_ENVIRONMENT','self-hosted')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                require_identity({**env,key:value})
    def test_minimal_environment_and_inherited_heap(self):
        env=clean_env('/node/bin/node',Path('/ci/private'),Path('/tmp/btsf-fixture'))
        self.assertEqual(env['NODE_OPTIONS'],'--max-old-space-size=256')
        self.assertEqual(env['NPM_CONFIG_USERCONFIG'],'/ci/private/user.npmrc')
        self.assertNotEqual(env['NPM_CONFIG_USERCONFIG'],env['NPM_CONFIG_GLOBALCONFIG'])
        for key in ['GITHUB_TOKEN','NODE_AUTH_TOKEN','BELLTEAM_ROOT','OPENAI_API_KEY','SSH_AUTH_SOCK']:
            self.assertNotIn(key,env)
    def test_complete_file_set_single_worker(self):
        argv=full_argv('/node',['test/z.test.mjs','test/a.test.mjs'])
        self.assertEqual(argv[-2:],['test/a.test.mjs','test/z.test.mjs'])
        self.assertIn('--test-concurrency=1',argv)
        self.assertIn('--max-old-space-size=256',argv)
        with self.assertRaises(ValueError):full_argv('/node',[])
    def test_no_skips_failures_or_truncated_tap_accepted(self):
        text='# tests 9\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'
        self.assertEqual(tap_totals(text)['tests'],9)
        for bad in [text.replace('# fail 0','# fail 1'),text.replace('# skipped 0','# skipped 1'),
                    text.replace('# cancelled 0','# cancelled 1'),text.replace('# tests 9','')]:
            with self.subTest(bad=bad),self.assertRaises(ValueError):tap_totals(bad)

    def test_short_empty_private_tmp(self):
        directory=temporary_directory()
        try:
            self.assertEqual(directory.parent,Path('/tmp'))
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode),0o700)
            self.assertEqual(list(directory.iterdir()),[])
            self.assertNotIn(ROOT,directory.parents)
            longest=directory/'bellteam-watch-close-failure-XXXXXX'/'calls.sock'
            self.assertLess(len(os.fsencode(longest)),108)
            env=clean_env('/node/bin/node',Path('/ci/private'),directory)
            self.assertEqual(env['TMPDIR'],str(directory))
            self.assertEqual(env['HOME'],'/ci/private/home')
        finally:
            shutil.rmtree(directory)

    def test_node_child_long_repo_tmp_fails_short_external_tmp_succeeds(self):
        node=shutil.which('node')
        self.assertIsNotNone(node)
        short=temporary_directory()
        try:
            with tempfile.TemporaryDirectory(prefix='tmp-'+'x'*80,dir=ROOT) as old:
                # The old allocator's long repository scope, not all historical failures.
                script=r"""
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),cp=require('node:child_process');
const base=process.env.TMPDIR;
const fake=path.join(base,'fake');fs.writeFileSync(fake,"const fs=require('node:fs');process.stdout.write('fixture-ok')");
const child=cp.spawnSync(process.execPath,[fake],{env:process.env,encoding:'utf8'});
const socket=path.join(base,'calls.sock'),server=net.createServer();let finished=false;
function finish(socketOK){if(finished)return;finished=true;process.stdout.write(JSON.stringify({childExit:child.status,output:child.stdout,error:child.stderr.includes('require is not defined'),socketOK,pathBytes:Buffer.byteLength(socket)}));}
server.on('error',()=>finish(false));server.listen(socket,()=>{const good=fs.existsSync(socket);server.close(()=>finish(good));});
"""
                observations=[]
                for directory in [Path(old),short]:
                    child=subprocess.run([node,'--max-old-space-size=256','-e',script],
                        env={'PATH':str(Path(node).parent)+':/usr/bin:/bin','TMPDIR':str(directory),
                             'NODE_OPTIONS':'--max-old-space-size=256'},
                        text=True,capture_output=True,timeout=5)
                    self.assertEqual(child.returncode,0,child.stderr)
                    observations.append(json.loads(child.stdout))
                before,after=observations
                self.assertEqual(before['childExit'],1)
                self.assertTrue(before['error'])
                self.assertFalse(before['socketOK'])
                self.assertGreaterEqual(before['pathBytes'],108)
                self.assertEqual(after['childExit'],0)
                self.assertEqual(after['output'],'fixture-ok')
                self.assertTrue(after['socketOK'])
                self.assertLess(after['pathBytes'],108)
                print(json.dumps({'case':'allocator-path-regression','before':before,'after':after}),flush=True)
        finally:
            shutil.rmtree(short)

if __name__=='__main__':unittest.main()
