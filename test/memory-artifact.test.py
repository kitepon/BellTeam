import copy, platform, hashlib, importlib.util, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from web_gateway_artifact import MEMORY_FILES, check_archive, validate_manifest, write_archive
from update_catalog import validate_memory_archive
from module_artifact_verifier import policy_for
spec=importlib.util.spec_from_file_location('installer',ROOT/'scripts/install-web-gateway-release.py')
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
SOURCE='a'*40
ARCH={'x86_64':'amd64','aarch64':'arm64'}[platform.machine()]

class MemoryArtifact(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
  for path in MEMORY_FILES:
   f=self.root/path;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes((ROOT/path.removeprefix('payload/')).read_bytes())
  self.state=json.loads(subprocess.check_output(['node','--input-type=module','-e','import { MEMORY_STATE_COMPATIBILITY as s } from "./src/memory/state-compatibility.mjs"; console.log(JSON.stringify(s))'],cwd=ROOT,text=True))
  self.archive=self.root/'archive.tar.gz';self.manifest=write_archive(self.root/'payload',self.archive,SOURCE,ARCH,component='memory',state_compatibility=self.state)
  with self.archive.open('rb') as stream:_,self.manifest_sha=check_archive(stream,SOURCE,ARCH,component='memory')
 def tearDown(self):
  for root,dirs,files in os.walk(self.root):os.chmod(root,0o700)
  self.temp.cleanup()
 def test_probe_uses_independent_traversable_root_and_cleans_success_and_failure(self):
  spec=importlib.util.spec_from_file_location('probe',ROOT/'test/helpers/memory-artifact-probe.py')
  probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
  parent_mode=self.root.stat().st_mode
  roots=[]
  def run(command,**options):
   entry=Path(command[1]);root=entry.parents[2];roots.append(root)
   self.assertEqual(root.parent,Path('/tmp'))
   self.assertFalse(root.is_relative_to(self.root))
   self.assertTrue(entry.is_file())
   for path in [root,root/'payload',entry.parent]:self.assertEqual(path.stat().st_mode&0o005,0o005)
   self.assertEqual((options['user'],options['group'],options['extra_groups']),(1000,1000,[]))
   self.assertEqual(list(Path(options['cwd']).iterdir()),[])
   request=json.loads(options['input'])
   value=dict(protocolVersion=1,generation=request['generation'],stateCompatibility=self.state,result=dict(restored=True))
   return subprocess.CompletedProcess(command,exit_code,stdout=json.dumps(value),stderr='')
  remove=probe.shutil.rmtree
  def remove_as_owner(path):
   # This unit fixture maps root cleanup capability to its unprivileged owner.
   for directory,_,_ in os.walk(path):os.chmod(directory,0o700)
   remove(path)
  for exit_code in [0,1]:
   with patch.object(probe.os,'geteuid',return_value=0),patch.object(probe.sys,'argv',['probe',str(self.archive),'/usr/bin/node']),patch.object(probe.subprocess,'run',side_effect=run),patch.object(probe.shutil,'rmtree',side_effect=remove_as_owner):
    if exit_code:
     with self.assertRaisesRegex(ValueError,'MEMORY_PROBE_FAILED'):probe.main()
    else:probe.main()
   self.assertFalse(roots[-1].exists())
   self.assertEqual(self.root.stat().st_mode,parent_mode)
 def test_closure_and_actual_state_reject_missing_extra_replaced_bad_types(self):
  self.assertEqual(set(f['path'] for f in self.manifest['files']),MEMORY_FILES)
  self.assertEqual(policy_for('memory')['signerWorkflow'],'kitepon/BellTeam/.github/workflows/publish-memory.yml')
  extra=copy.deepcopy(self.manifest);extra['files'].append(dict(path='payload/src/memory/new-helper.mjs',bytes=0,sha256='0'*64))
  self.assertIs(validate_manifest(extra,component='memory'),extra)
  for change in [lambda m:m.update(files=[f for f in m['files'] if f['path']!=m['entry']]),lambda m:m.update(entry='payload/src/run-seat-runtime.mjs'),lambda m:m['runtime']['stateCompatibility'].update(memoryUserVersion=False),lambda m:m['runtime']['stateCompatibility'].update(searchIndexVersion='1:unknown'),lambda m:m['runtime']['stateCompatibility'].update(extra=1),lambda m:m['runtime']['stateCompatibility'].pop('knowledgeEncoding')]:
   value=copy.deepcopy(self.manifest);change(value)
   with self.assertRaises(ValueError):validate_manifest(value,component='memory')
 def test_catalog_manifest_consumer_full_equality_including_icu(self):
  release=dict(componentId='memory',sourceCommit=SOURCE,platform=dict(os='linux',arch=ARCH),compatibility=dict(nodeMajor=26,parentProtocol=1,stateSchema=None,containerUpdate=None,stateCompatibility=self.state))
  validate_memory_archive(release,self.manifest,self.state)
  for target in ['catalog','manifest','consumer']:
   r,m,c=copy.deepcopy(release),copy.deepcopy(self.manifest),copy.deepcopy(self.state)
   state=r['compatibility']['stateCompatibility'] if target=='catalog' else m['runtime']['stateCompatibility'] if target=='manifest' else c
   state['searchIndexVersion']='1:999.0'
   with self.assertRaises(ValueError):validate_memory_archive(r,m,c)
 def test_code_first_orphan_recovery_never_exposes_private_metadata(self):
  private=self.root/'private';private.mkdir();code_root=private/'memory-code';code_root.mkdir();code_root.chmod(0o555)
  version=hashlib.sha256(self.archive.read_bytes()).hexdigest();expected=dict(archiveSha256=version,sourceCommit=SOURCE,signerCommit=SOURCE)
  receipt=dict(schema='bellteam.memory.verification.v1',archiveSha256=version,manifestSha256=self.manifest_sha,manifest=self.manifest,verification=dict(method='github-oidc-attestation',repositoryId='1404510084'))
  def stage(name):
   s=self.root/name;s.mkdir();out=s/'release';out.mkdir();installer.extract(self.archive,receipt,expected,out,'memory');return s,out
  real_publish=installer.publish
  def publish_as_owner(source,target):
   # Root privilege is mapped to the fixture owner only around real NOREPLACE rename.
   target.parent.chmod(0o755);source.chmod(0o755)
   try:real_publish(source,target)
   finally:
    target.parent.chmod(0o555);(target if target.exists() else source).chmod(0o555)
  real_rename=os.rename
  def move_as_owner(source,target):
   source.chmod(0o755)
   try:real_rename(source,target)
   finally:(target if target.exists() else source).chmod(0o555)
  with patch.object(installer,'ROOT_UID',os.getuid()),patch.object(installer,'publish',side_effect=publish_as_owner),patch.object(installer.os,'rename',side_effect=move_as_owner):
   s,out=stage('first');installer.publish_memory_code(private,s,out,self.manifest,version)
   self.assertEqual(sorted(x.name for x in out.iterdir()),['installation.json','manifest.json'])
   self.assertEqual(sorted(x.name for x in (code_root/version).iterdir()),['payload'])
   self.assertFalse((private/'memory'/'releases'/version).exists());installer.verify_memory_code(code_root/version,self.manifest)
   s2,out2=stage('retry');installer.publish_memory_code(private,s2,out2,self.manifest,version)
   self.assertEqual(sorted(x.name for x in out2.iterdir()),['installation.json','manifest.json'])
   file=code_root/version/self.manifest['files'][0]['path'];file.chmod(0o644);file.write_bytes(b'changed');file.chmod(0o444)
   s3,out3=stage('changed')
   with self.assertRaisesRegex(ValueError,'MEMORY_CODE_CONTENT'):installer.publish_memory_code(private,s3,out3,self.manifest,version)
   self.assertTrue((out3/'payload').exists())
 def test_official_verifier_requires_trusted_image_icu_after_signature(self):
  import module_artifact_verifier as verifier
  expected=dict(archiveSha256=hashlib.sha256(self.archive.read_bytes()).hexdigest(),sourceCommit=SOURCE,signerCommit=SOURCE)
  def output(command,**options):
   return '26\n' if '-p' in command else json.dumps(self.state)
  with self.archive.open('rb') as a,self.archive.open('rb') as b,self.archive.open('rb') as t,patch.object(verifier,'verify_signature') as signature,patch.object(verifier.subprocess,'check_output',side_effect=output):
   result=verifier.authenticate(a,b,t,policy_for('memory'),expected,component='memory')
   self.assertEqual(result['manifest'],self.manifest);signature.assert_called_once()
  wrong={**self.state,'searchIndexVersion':'1:999.0'}
  with self.archive.open('rb') as a,self.archive.open('rb') as b,self.archive.open('rb') as t,patch.object(verifier,'verify_signature'),patch.object(verifier.subprocess,'check_output',side_effect=lambda command,**kw:'26\n' if '-p' in command else json.dumps(wrong)):
   with self.assertRaisesRegex(ValueError,'MEMORY_IMAGE_STATE_INCOMPATIBLE'):verifier.authenticate(a,b,t,policy_for('memory'),expected,component='memory')
 def test_root_extract_rejects_wrong_component_state_source_before_output(self):
  receipt=dict(schema='bellteam.memory.verification.v1',archiveSha256='b'*64,manifestSha256=self.manifest_sha,manifest=self.manifest,verification=dict(method='github-oidc-attestation',repositoryId='1404510084'))
  expected=dict(archiveSha256='b'*64,sourceCommit=SOURCE,signerCommit=SOURCE)
  for change in [lambda r:r['manifest'].update(component='members'),lambda r:r['manifest']['runtime'].update(parentProtocol=2),lambda r:r['manifest']['runtime']['stateCompatibility'].update(memoryUserVersion=1),lambda r:r['manifest'].update(sourceCommit='c'*40)]:
   r=copy.deepcopy(receipt);change(r);out=self.root/'rejected';out.mkdir()
   with self.assertRaises(ValueError):installer.extract(self.archive,r,expected,out,'memory')
   self.assertEqual(list(out.iterdir()),[]);out.rmdir()
if __name__=='__main__':unittest.main()
