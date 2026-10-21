"""Synthetic isolated-container tests; not a host/user installer."""
import json,os,pathlib,signal,subprocess,time,unittest

ENTRY='/usr/local/libexec/bellteam-seat-exec'
class SeatEntry(unittest.TestCase):
 def invoke(self,*args,**kwargs):
  return subprocess.run(['sudo','-n','--',ENTRY,*args],text=True,capture_output=True,timeout=10,**kwargs)
 def test_identity_environment_and_stdio(self):
  code="""import os,json,sys
s=open('/proc/self/status').read().splitlines()
print(json.dumps({'uid':os.getresuid(),'gid':os.getresgid(),'groups':os.getgroups(),'env':dict(os.environ),'input':sys.stdin.read(),'caps':[x for x in s if x.startswith(('CapEff:','CapPrm:','CapAmb:'))]}))
"""
  r=self.invoke('--','/usr/bin/python3','-I','-c',code,input='synthetic input\n',env={**os.environ,'BELLTEAM_SYNTHETIC_SERVER_SECRET':'synthetic-canary','NODE_OPTIONS':'synthetic-not-a-real-option'})
  self.assertEqual(r.returncode,0,r.stderr);d=json.loads(r.stdout)
  self.assertEqual(d['uid'],[1000]*3);self.assertEqual(d['gid'],[1000]*3);self.assertEqual(d['groups'],[])
  self.assertEqual(d['input'],'synthetic input\n');self.assertNotIn('BELLTEAM_SYNTHETIC_SERVER_SECRET',d['env']);self.assertNotIn('NODE_OPTIONS',d['env'])
  self.assertTrue(all(int(x.split()[1],16)==0 for x in d['caps']))
  self.assertEqual(d['env']['HOME'],'/home/bell');self.assertEqual(d['env']['DISABLE_AUTOUPDATER'],'1')
 def test_exit_and_fixed_errors(self):
  self.assertEqual(self.invoke('--','/bin/sh','-c','exit 37').returncode,37)
  r=self.invoke('--','/does/not/exist/secret-placeholder');self.assertEqual(r.returncode,126);self.assertEqual(r.stderr,'BELLTEAM_SEAT_EXEC_EXEC\n');self.assertEqual(r.stdout,'')
  self.assertEqual(self.invoke('invalid').stderr,'BELLTEAM_SEAT_EXEC_ARGUMENTS\n')
 def test_server_cannot_invoke_arbitrary_root_command(self):
  r=subprocess.run(['sudo','-n','/usr/bin/id','-u'],capture_output=True,text=True)
  self.assertNotEqual(r.returncode,0)
 def test_seat_grant_is_preserved(self):
  # Existing owner-approved bell NOPASSWD grant is deliberately retained.
  r=self.invoke('--','sudo','-n','/usr/bin/id','-u');self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stdout.strip(),'0')
 def test_direct_unprivileged_entry_is_rejected(self):
  r=subprocess.run([ENTRY,'--','/usr/bin/id'],capture_output=True,text=True)
  self.assertEqual(r.returncode,126);self.assertEqual(r.stderr,'BELLTEAM_SEAT_EXEC_ROOT_REQUIRED\n')
 def test_cancellation_through_sudo_reaches_seat_process(self):
  marker=pathlib.Path('/tmp/seat-cancel-marker');marker.unlink(missing_ok=True)
  code="import os,pathlib,time;pathlib.Path('/tmp/seat-cancel-marker').write_text(str(os.getpid()));print('ready',flush=True);time.sleep(30)"
  child=subprocess.Popen(['sudo','-n','--',ENTRY,'--','/usr/bin/python3','-I','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   self.assertEqual(child.stdout.readline().strip(),'ready');pid=int(marker.read_text());child.terminate();child.wait(timeout=5)
   # A returned sudo monitor alone is insufficient; check its actual synthetic child.
   deadline=time.monotonic()+3
   while pathlib.Path('/proc',str(pid)).exists() and time.monotonic()<deadline:time.sleep(.02)
   self.assertFalse(pathlib.Path('/proc',str(pid)).exists())
  finally:
   if child.poll() is None:child.kill();child.wait()
   child.stdout.close();child.stderr.close()

if __name__=='__main__':unittest.main(verbosity=2)
