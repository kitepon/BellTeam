import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import candidate as c

class Boundaries(unittest.TestCase):
    def test_fixed_source_and_candidate_tags(self):
        self.assertEqual(c.source('a'*40),'a'*40)
        for s in ['main','a'*39,'a'*40+';echo x']:
            with self.assertRaises(ValueError):c.source(s)
        for arch in ['amd64','arm64',None]:self.assertIn(':security-'+'a'*40+'-12',c.tag('a'*40,'12',arch))
        for value in ['latest','stable','a;echo x']:
            with self.assertRaises(ValueError):c.tag('a'*40,'12',value)
    def inspect(self):
        return {'id':'b'*64,'image':'sha256:'+'c'*64,'name':'/fixture','labels':{'centi.security':'12'},'user':'1000:1000','entry':['node'],'args':['--max-old-space-size=256','/app/test/probe.mjs'],'memory':2147483648,'swap':2147483648,'cpus':1000000000,'pids':512,'ro':True,'network':'none','capDrop':['ALL'],'security':['no-new-privileges:true'],'tmpfs':{'/tmp':'rw,noexec,nosuid,size=67108864,mode=1777'},'mounts':[{'Type':'bind','Source':'/ci/probe','Destination':'/app/test','RW':False,'Propagation':'rprivate'}],'state':{'Status':'created','Running':False}}
    def validate(self,d):c.valid_inspect(d,'b'*64,'sha256:'+'c'*64,'fixture','12',Path('/ci/probe'))
    def test_created_and_stopped_identity(self):
        d=self.inspect();self.validate(d);d['state']['Status']='exited';self.validate(d)
    def test_mount_caps_and_foreign_refused(self):
        for key,value in [('id','d'*64),('memory',0),('swap',0),('ro',False),('network','host')]:
            d=self.inspect();d[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.validate(d)
        for rw in [True,None]:
            d=self.inspect();d['mounts'][0]['RW']=rw
            with self.assertRaises(ValueError):self.validate(d)
    def test_running_not_removed(self):
        d=self.inspect();d['state'].update(Status='running',Running=True)
        with patch.object(c,'UNKNOWN',False),patch.object(c,'STATE',{'cid':'b'*64,'image':'sha256:'+'c'*64,'fixtureName':'fixture','probe':'/ci/probe'}),patch.object(c,'command') as command:
            command.return_value.read_text.return_value=json.dumps(d)
            with self.assertRaises(ValueError):c.cleanup('12')
            self.assertEqual(command.call_count,1)
    def test_unknown_no_more_commands(self):
        with patch.object(c,'UNKNOWN',True),patch.object(c.subprocess,'Popen') as spawn:
            with self.assertRaises(ValueError):c.command(['docker','rm','fixture'],10)
            spawn.assert_not_called()
    def test_known_stopped_cleanup_no_force(self):
        d=self.inspect();d['state']['Status']='exited'
        with tempfile.TemporaryDirectory() as tmp,patch.object(c,'OUT',Path(tmp)),patch.object(c,'UNKNOWN',False),patch.object(c,'STATE',{'cid':'b'*64,'image':'sha256:'+'c'*64,'fixtureName':'fixture','probe':'/ci/probe'}),patch.object(c,'command') as command:
            command.return_value.read_text.side_effect=[json.dumps(d),'']
            c.cleanup('12');self.assertTrue(c.STATE['absenceConfirmed'])
            self.assertEqual(command.call_args_list[1].args[0],['docker','rm','b'*64])
    def test_publish_requires_probe_and_absence(self):
        with patch.object(c,'STATE',{}),patch.object(c,'command') as command:
            with self.assertRaises(ValueError):c.publish('a'*40,'amd64','12')
            command.assert_not_called()
    def test_projection_never_includes_env(self):
        self.assertNotIn('Env',c.projection());self.assertIn('{{json .Image}}',c.projection())
    def test_registry_deadline_before_network(self):
        with patch.object(c,'DEADLINE',time.monotonic()-1),patch.object(c.urllib.request,'urlopen') as network:
            with self.assertRaises(ValueError):c.raw_request('https://ghcr.io/')
            network.assert_not_called()

class Counter(unittest.TestCase):
 def test_unconfirmed_postspawn_must_latch_and_prevent_next_command(self):
  for boundary in ['wait','save_after_spawn']:
   with self.subTest(boundary=boundary),tempfile.TemporaryDirectory() as tmp:
    calls=[]
    class Child:
     pid=12345
     def wait(self):
      if boundary=='wait' and len(calls)==1: raise OSError('synthetic wait failure')
      return 0
    def spawn(*a,**kw):calls.append(a[0]);return Child()
    state={};original_save=c.save
    def save():
     if boundary=='save_after_spawn' and len(calls)==1 and state['commands'][-1].get('wrapperPid') and 'exitCode' not in state['commands'][-1]:raise OSError('synthetic terminal-unknown receipt failure')
     original_save()
    with patch.object(c,'OUT',Path(tmp)),patch.object(c,'STATE',state),patch.object(c,'UNKNOWN',False),patch.object(c,'DEADLINE',time.monotonic()+120),patch.object(c,'environment',return_value={}),patch.object(c.subprocess,'Popen',side_effect=spawn),patch.object(c,'save',side_effect=save):
     try:c.command(['docker','start','-a','owned-fixture'],10)
     except OSError:pass
     first_latched=c.UNKNOWN
     try:c.command(['docker','inspect','owned-fixture'],10)
     except (ValueError,OSError):pass
     print(json.dumps({'boundary':boundary,'unknownLatched':first_latched,'subsequentSpawn':len(calls)-1,'realChild':0,'Docker':0}),flush=True)
     self.assertTrue(first_latched,'unconfirmed spawned client must latch')
     self.assertEqual(len(calls),1)

class KnownTerminal(unittest.TestCase):
    def test_nonzero_exit_remains_known(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(c,'OUT',Path(tmp)),patch.object(c,'STATE',{}),patch.object(c,'UNKNOWN',False),patch.object(c,'DEADLINE',time.monotonic()+120),patch.object(c,'environment',return_value={}),patch.object(c.subprocess,'Popen') as spawn:
            spawn.return_value.pid=12345;spawn.return_value.wait.return_value=7
            with self.assertRaisesRegex(ValueError,'COMMAND_FAILED_0'):
                c.command(['docker','start','-a','owned-fixture'],10)
            self.assertFalse(c.UNKNOWN)
            self.assertEqual(c.STATE['commands'][0]['exitCode'],7)
            self.assertEqual(spawn.call_count,1)

if __name__=='__main__':unittest.main()
