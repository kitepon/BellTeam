import assert from 'node:assert/strict'
import {execFile, spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import test from 'node:test'

const exec = promisify(execFile)
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deploy-health-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  for (const dir of ['scripts', 'bin', 'runtime/backups', '.bellteam-compose.ABC123'])
    await mkdir(join(root, dir), {recursive:true})
  for (const name of ['deploy.sh', 'deploy-host.sh', 'deploy-cleanup.sh'])
    await copyFile(new URL('../scripts/' + name, import.meta.url), join(root, 'scripts', name))
  const saved = join(root, '.bellteam-compose.ABC123'), image = 'sha256:' + 'b'.repeat(64)
  await writeFile(join(saved, 'previous-runtime.json'), JSON.stringify({Image:image}))
  await writeFile(join(saved, 'previous-normal.json'), JSON.stringify({services:{bellteam:{image}}}))
  await writeFile(join(root, 'scripts/deploy-image.sh'), `#!/bin/sh
printf 'adapter\\n' >> "$FIXTURE_LOG"
if [ "$FIXTURE_STALL" = 1 ]; then
  touch "$FIXTURE_ROOT/started"
  while [ ! -f "$FIXTURE_ROOT/release" ] && [ -d "$FIXTURE_ROOT" ]; do /bin/sleep 0.02; done
fi
printf 'deploy-exit=%s\\n' "$FIXTURE_ADAPTER_EXIT"
exit "$FIXTURE_ADAPTER_EXIT"
`)
  const programs = {
    git: '#!/bin/sh\nif [ "$1" = rev-parse ]; then printf "%040d\\n" 1; fi\n',
    date: '#!/bin/sh\nprintf fixture\n',
    sleep: '#!/bin/sh\n/bin/sleep 0.02\n',
    sudo: '#!/bin/sh\nshift\nexec "$@"\n',
    docker: `#!${process.execPath}
const fs=require('node:fs'), args=process.argv.slice(2).join(' ')
fs.appendFileSync(process.env.FIXTURE_LOG, args+'\\n')
if(args.includes('/healthz')){process.stdout.write(process.env.FIXTURE_HEALTH);process.exit(Number(process.env.FIXTURE_HEALTH_EXIT))}
if(args.includes('/api/bots'))console.log('{"bots":[]}')
`,
    python3: `#!${process.execPath}
require('node:fs').appendFileSync(process.env.FIXTURE_LOG, 'cleanup '+JSON.stringify(process.argv.slice(2))+'\\n')
console.log('{"schema":"fixture.plan"}')
console.error('fixture cleanup stderr')
process.exit(Number(process.env.FIXTURE_CLEANUP_EXIT))
`,
    ssh: `#!${process.execPath}
const fs=require('node:fs'), cp=require('node:child_process'), e=process.env, command=process.argv[3]
fs.appendFileSync(e.FIXTURE_SSH_LOG, command+'\\n')
if(command.includes('sh -s')){fs.readFileSync(0);console.log('/home/kite/BellTeam/.bellteam-compose.ABC123/previous-normal.json');process.exit()}
if(command.includes('/api/queue'))process.exit()
// Run the actual detached launch and log reads, replacing only Host location and privilege isolation.
const local=command.replaceAll('/home/kite/BellTeam',e.FIXTURE_ROOT).replace('/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root LANG=C.UTF-8','/usr/bin/env')
const child=cp.spawnSync('/bin/sh',['-c',local],{env:e,encoding:'utf8'})
process.stdout.write(child.stdout);process.stderr.write(child.stderr);process.exit(child.status ?? 1)
`,
  }
  for (const [name, program] of Object.entries(programs)) {
    await writeFile(join(root, 'bin', name), program)
    await chmod(join(root, 'bin', name), 0o755)
  }
  const env = {...process.env, PATH:`${join(root,'bin')}:${process.env.PATH}`,
    FIXTURE_ROOT:root, FIXTURE_LOG:join(root,'calls'), FIXTURE_SSH_LOG:join(root,'ssh-calls'),
    FIXTURE_HEALTH:'{"status":"ok"}', FIXTURE_HEALTH_EXIT:'0', FIXTURE_CLEANUP_EXIT:'0',
    FIXTURE_ADAPTER_EXIT:'0', FIXTURE_STALL:'0',
    BELLTEAM_DEPLOY_IMAGE:`ghcr.io/fixture/server@sha256:${'a'.repeat(64)}`, ...extra}
  return {root, saved, env, run:()=>exec('/bin/sh', ['scripts/deploy.sh'], {cwd:root, env}),
    log:()=>readFile(join(root, 'runtime/backups/deploy-fixture.log'), 'utf8'),
    calls:async()=>(await readFile(env.FIXTURE_LOG,'utf8')).trim().split('\n')}
}

for (const [name, extra, success, cleanup = false] of [
  ['healthy', {}, true, true],
  ['unhealthy', {FIXTURE_HEALTH:'{"status":"unhealthy","ok":true}'}, false],
  ['invalid-json', {FIXTURE_HEALTH:'not-json'}, false],
  ['docker-failed', {FIXTURE_HEALTH_EXIT:'7'}, false],
  ['adapter-failed', {FIXTURE_ADAPTER_EXIT:'57'}, false],
  ['cleanup-failed', {FIXTURE_CLEANUP_EXIT:'17'}, false, true],
]) test(`deploy host completion: ${name}`, async t => {
  const f = await fixture(t, extra), result = await f.run().catch(error => error)
  const calls = await f.calls(), log = await f.log(), ssh = await readFile(f.env.FIXTURE_SSH_LOG,'utf8')
  assert.equal(result.code ?? 0, success ? 0 : 1)
  assert.match(log, success ? /deploy-caller-exit=0\n$/ : /deploy-caller-exit=[1-9][0-9]*\n$/)
  assert.equal(calls.filter(c=>c.startsWith('cleanup ')).length, cleanup ? 1 : 0)
  assert.equal(ssh.split('\n').filter(c=>c.includes('setsid nohup')).length, 1)
  assert.doesNotMatch(ssh, /\/healthz|sh scripts\/deploy-cleanup.sh|\/api\/bots/)
  if(cleanup){
    assert.ok(calls.findIndex(c=>c.startsWith('cleanup ')) > calls.findIndex(c=>c.includes('/healthz')))
    const manifest = JSON.parse(await readFile(join(f.saved,'deploy-cleanup.json'),'utf8'))
    assert.equal(manifest.exit, Number(extra.FIXTURE_CLEANUP_EXIT ?? 0))
    assert.equal(manifest.previousRuntime, join(f.saved,'previous-runtime.json'))
    if(!success){assert.match(log,/本体はhealthy/u);assert.equal(calls.some(c=>c.includes('/api/bots')),false)}
    else assert.match(log,/bots 0 online 0/)
  }else if(name === 'adapter-failed'){
    assert.match(log,/deploy-exit=57/)
    assert.equal(calls.some(c=>c.includes('/healthz')),false)
  }else{
    assert.match(log,/healthzの正常応答/u)
    assert.equal(calls.filter(c=>c.includes('/healthz')).length,24)
  }
})

async function until(read, predicate) {
  for(let n=0;n<500;n++){
    const value=await read().catch(()=>null)
    if(predicate(value))return value
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.fail('fixture did not reach terminal state')
}

test('Host finishes cleanup and saves results after the entire launching client process group disappears', async t => {
  const f = await fixture(t, {FIXTURE_STALL:'1'})
  const client = spawn('/bin/sh',['scripts/deploy.sh'],{cwd:f.root,env:f.env,detached:true,stdio:'ignore'})
  const exited = new Promise(resolve=>client.once('exit',resolve))
  t.after(()=>{try{process.kill(-client.pid,'SIGKILL')}catch{}})
  await until(()=>readFile(join(f.root,'started'),'utf8'),v=>v!==null)
  process.kill(-client.pid,'SIGKILL')
  await exited
  await writeFile(join(f.root,'release'),'continue')
  const log=await until(f.log,v=>v?.includes('deploy-caller-exit='))
  assert.match(log,/deploy-exit=0/)
  assert.match(log,/deploy-caller-exit=0\n$/)
  assert.equal((await f.calls()).filter(c=>c.startsWith('cleanup ')).length,1)
  for(const file of ['deploy-cleanup.stdout.jsonl','deploy-cleanup.stderr.log','deploy-cleanup.json'])
    assert.ok((await readFile(join(f.saved,file))).length>0)
  assert.equal(JSON.parse(await readFile(join(f.saved,'deploy-cleanup.json'))).exit,0)
})
