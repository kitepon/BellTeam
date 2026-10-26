import importlib.util,pathlib,sys,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
import accept as ci
class CIConditions(unittest.TestCase):
 def test_preflight_thresholds(self):
  gib=2**30
  self.assertTrue(ci.resource_values(8*gib,20*gib,True))
  for ram,disk in [(8*gib-1,20*gib),(8*gib,20*gib-1)]:
   with self.assertRaises(ci.Held):ci.resource_values(ram,disk,True)
 def test_running_thresholds_are_ci_specific(self):
  gib=2**30
  self.assertTrue(ci.resource_values(4*gib,8*gib,False))
  for ram,disk in [(4*gib-1,8*gib),(4*gib,8*gib-1)]:
   with self.assertRaises(ci.Held):ci.resource_values(ram,disk,False)
 def test_no_docker_mutation_after_resource_refusal(self):
  with patch.object(ci,'resources',side_effect=ci.Held('low')),patch.object(ci.subprocess,'Popen') as spawn:
   with self.assertRaises(ci.Held):ci.command(['docker','pull','forbidden'])
   spawn.assert_not_called()
 def test_non_github_hosted_entry_is_refused(self):
  with patch.object(ci.sys,'argv',['accept.py','amd64']),patch.dict(ci.os.environ,{'GITHUB_ACTIONS':'false','CI_RUNNER_ENVIRONMENT':'self-hosted'}),patch.object(ci.subprocess,'check_output') as command:
   with self.assertRaises(ci.Held):ci.main()
   command.assert_not_called()
 def test_unknown_architecture_is_refused_before_docker(self):
  with patch.object(ci.sys,'argv',['accept.py','unknown']),patch.object(ci.subprocess,'check_output') as command:
   with self.assertRaises(ci.Held):ci.main()
   command.assert_not_called()
 def test_cgroup_version_refused_before_pull(self):
  import json
  with patch.object(ci.sys,'argv',['accept.py','amd64']),patch.dict(ci.os.environ,{'GITHUB_ACTIONS':'true','CI_RUNNER_ENVIRONMENT':'github-hosted','GITHUB_RUN_ID':'123'}),patch.object(ci.platform,'machine',return_value='x86_64'),patch.object(ci.subprocess,'check_output',return_value=json.dumps({'root':'/var/lib/docker','cgroupVersion':'1','architecture':'x86_64'})),patch.object(ci.subprocess,'Popen') as spawn:
   with self.assertRaises(AssertionError):ci.main()
   spawn.assert_not_called()
 def test_fixed_artifact_identity(self):
  import json,hashlib
  context=json.loads((ROOT/'context-files.json').read_text())
  self.assertEqual(len(context),139)
  self.assertEqual(ci.PLAN['source'],'a8782a84e1e3da900f9dab6f557dc2e2a6218247')
  self.assertEqual(ci.PLAN['image'],'sha256:c5a20bd36a8f3ee3fd6e7f23872931125e159a45baf7e01a56185fbb7c5e4c2e')
  self.assertEqual(hashlib.sha256((ROOT/'runtime-artifact.mjs').read_bytes()).hexdigest(),'5239a069b6617fd7b5f3e788b37623c0dd0f023b24010ed2f0c100f25b336d7b')
if __name__=='__main__':unittest.main()
