"""UID1001 fixture only. All environment/canary values are synthetic."""
import json,os,pathlib,signal,subprocess,time,unittest

ENTRY=['sudo','-n','--','/usr/local/libexec/bellteam-seat-exec','--','/usr/local/bin/node','/app/src/run-seat-command.mjs']
PROJECT='/synthetic-seat-project'
class SeatCommand(unittest.TestCase):
 def invoke(self,*args,input='',project=PROJECT):
  return subprocess.run([*ENTRY,project,'--',*args],input=input,text=True,capture_output=True,timeout=10,
   env={**os.environ,'BELLTEAM_SYNTHETIC_SERVER_SECRET':'synthetic-server','NODE_OPTIONS':'synthetic-invalid','AITERM_AGENT_LAUNCH_ID':'server-must-not-leak'})
 def test_uid_environment_stdio_exit(self):
  code="import os,json,sys;print(json.dumps({'uid':os.getresuid(),'env_uid':os.environ['SYNTHETIC_ENV_UID'],'seat':os.environ['SYNTHETIC_SEAT_SETTING'],'server_key': 'BELLTEAM_SYNTHETIC_SERVER_SECRET' in os.environ,'launch': 'AITERM_AGENT_LAUNCH_ID' in os.environ,'input':sys.stdin.read()}));sys.exit(37)"
  r=self.invoke('/usr/bin/python3','-I','-c',code,input='synthetic protocol\n')
  self.assertEqual(r.returncode,37,r.stderr);self.assertEqual(r.stderr,'')
  self.assertEqual(json.loads(r.stdout),{'uid':[1000]*3,'env_uid':'1000','seat':'from-seat-env','server_key':False,'launch':False,'input':'synthetic protocol\n'})
 def test_bad_environment_is_fixed_failure_without_starting_target(self):
  r=self.invoke('/usr/bin/printf','must-not-run',project='/synthetic-bad-project')
  self.assertNotEqual(r.returncode,0);self.assertEqual(r.stdout,'');self.assertEqual(r.stderr,'BELLTEAM_SEAT_COMMAND_FAILED\n')
 def test_actual_sdk_stdio_mcp_runs_as_seat(self):
  # The parent is UID1001. Only the SDK's MCP child crosses the fixed entry.
  code="""import {AitermClient} from '/app/src/aiterm-transport.mjs';
const c=new AitermClient({command:'/usr/local/bin/node',args:['/app/seat-sdk-fixture.mjs'],seatProject:'/synthetic-seat-project'});
try{console.log(JSON.stringify((await c.call('probe',{}, {meta:{fixture:'synthetic-meta'}})).structuredContent));
try{await c.call('probe',{}, {env:{BELLTEAM_SYNTHETIC_SERVER_SECRET:'synthetic'}});throw Error('accepted unsafe environment')}catch(e){if(e.message!=='SEAT_DYNAMIC_ENV_UNWIRED')throw e}}
finally{await c.close()}
"""
  r=subprocess.run(['/usr/local/bin/node','--input-type=module','-e',code],capture_output=True,text=True,timeout=10,
   env={**os.environ,'BELLTEAM_SYNTHETIC_SERVER_SECRET':'synthetic-server'})
  self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(json.loads(r.stdout),{'uid':1000,'env_uid':'1000','server_key':False,'meta':'synthetic-meta'})
 def test_cancel_after_environment_reaches_actual_target(self):
  marker=pathlib.Path('/tmp/seat-command-pid');marker.unlink(missing_ok=True)
  code="import os,pathlib,time;pathlib.Path('/tmp/seat-command-pid').write_text(str(os.getpid()));print('ready',flush=True);time.sleep(30)"
  child=subprocess.Popen([*ENTRY,PROJECT,'--','/usr/bin/python3','-I','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   self.assertEqual(child.stdout.readline().strip(),'ready');pid=int(marker.read_text());child.terminate();child.wait(timeout=5)
   deadline=time.monotonic()+3
   while pathlib.Path('/proc',str(pid)).exists() and time.monotonic()<deadline:time.sleep(.02)
   self.assertFalse(pathlib.Path('/proc',str(pid)).exists())
  finally:
   if child.poll() is None:child.kill();child.wait()
   child.stdout.close();child.stderr.close()
 def test_cancel_during_env_prevents_target_and_stops_env_child(self):
  marker=pathlib.Path('/tmp/seat-env-pid');marker.unlink(missing_ok=True)
  child=subprocess.Popen([*ENTRY,'/synthetic-slow-project','--','/usr/bin/printf','must-not-run'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   deadline=time.monotonic()+3
   while not marker.exists() and time.monotonic()<deadline:time.sleep(.02)
   self.assertTrue(marker.exists());pid=int(marker.read_text());child.terminate();out,err=child.communicate(timeout=5)
   self.assertEqual(out,'');self.assertFalse(pathlib.Path('/proc',str(pid)).exists())
  finally:
   if child.poll() is None:child.kill();child.wait()
 def force_cancel(self,code,project=PROJECT,marker='/tmp/seat-ignore-pid'):
  path=pathlib.Path(marker);path.unlink(missing_ok=True)
  child=subprocess.Popen([*ENTRY,project,'--','/usr/bin/python3','-I','-c',code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  try:
   deadline=time.monotonic()+3
   while not path.exists() and time.monotonic()<deadline:time.sleep(.02)
   self.assertTrue(path.exists());pid=int(path.read_text());started=time.monotonic();child.terminate()
   out,err=child.communicate(timeout=3)
   self.assertLess(time.monotonic()-started,2)
   self.assertNotEqual(child.returncode,0)
   deadline=time.monotonic()+1
   while pathlib.Path('/proc',str(pid)).exists() and time.monotonic()<deadline:time.sleep(.02)
   status=pathlib.Path('/proc',str(pid),'stat')
   self.assertFalse(status.exists(),status.read_text() if status.exists() else '')
   self.assertNotIn('must-not-run',out)
  finally:
   if child.poll() is None:child.kill();child.wait()
   if path.exists():
    try:os.kill(int(path.read_text()),signal.SIGKILL)
    except (ProcessLookupError,PermissionError):pass
 def test_term_ignored_by_target_escalates_before_close(self):
  self.force_cancel("import os,pathlib,signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path('/tmp/seat-ignore-target-pid').write_text(str(os.getpid()));time.sleep(30)",marker='/tmp/seat-ignore-target-pid')
 def test_term_ignored_during_env_never_starts_target(self):
  self.force_cancel("print('must-not-run')",project='/synthetic-ignore-project')
 def test_env_descendant_holding_stdout_cannot_block_escalation(self):
  self.force_cancel("print('must-not-run')",project='/synthetic-pipe-project',marker='/tmp/seat-pipe-pid')
  self.assertTrue(pathlib.Path('/tmp/seat-pipe-fd').read_text().startswith(('socket:[','pipe:[')))
 def test_env_leader_close_does_not_cancel_escalation_for_live_group(self):
  self.force_cancel("print('must-not-run')",project='/synthetic-orphan-project',marker='/tmp/seat-orphan-pid')
  self.assertEqual(pathlib.Path('/tmp/seat-orphan-fd').read_text(),'/dev/null')

if __name__=='__main__':unittest.main(verbosity=2)
