"""UID1001 fixture only. All environment/canary values are synthetic."""
import json,os,pathlib,subprocess,time,unittest

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

if __name__=='__main__':unittest.main(verbosity=2)
