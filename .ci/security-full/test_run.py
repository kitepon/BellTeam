import os
from pathlib import Path
import unittest
from run import BRANCH, SOURCE, clean_env, full_argv, require_identity, tap_totals

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
        env=clean_env('/node/bin/node',Path('/ci/private'))
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

if __name__=='__main__':unittest.main()
