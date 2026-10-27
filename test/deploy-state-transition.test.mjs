import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stateWriterPlan } from '../src/server-state-writers.mjs'

const exec = promisify(execFile), id = 'sha256:' + 'a'.repeat(64)
const leaves = ['state', 'rooms', 'owner', 'logs', 'bellteam-settings', 'apns']
const targets = ['state', 'rooms', 'owner', 'logs', 'shared/tools/bellteam-settings', 'shared/tools/apns']
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'internal-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['scripts', 'bin', 'image/scripts']) await mkdir(join(root, dir), { recursive: true })
  await copyFile(process.env.DEPLOY_IMAGE_UNDER_TEST || new URL('../scripts/deploy-image.sh', import.meta.url), join(root, 'scripts/deploy-image.sh'))
  for (const file of ['compose.cursor-update.yaml', 'compose.state-prepare.yaml', 'compose.state-maintenance.json'])
    await copyFile(new URL('../' + file, import.meta.url), join(root, 'image', file))
  await writeFile(join(root, 'scripts/check-deploy-quiet.sh'), '#!/bin/sh\ndocker fixture-quiet\n')
  await writeFile(join(root, 'image/scripts/update-cursor.sh'), '#!/bin/sh\ndocker fixture-cursor\n')
  await writeFile(join(root, 'image/scripts/assert-state-writers-stopped.sh'), '#!/bin/sh\ndocker fixture-verify\n')
  await writeFile(join(root, 'bin/docker'), '#!' + process.execPath + '\n' + String.raw`
const fs=require('node:fs'),{spawnSync}=require('node:child_process'),a=process.argv.slice(2),e=process.env;
const leaves=['state','rooms','owner','logs','bellteam-settings','apns'];
const targets=['state','rooms','owner','logs','shared/tools/bellteam-settings','shared/tools/apns'];
const bind=(source,target)=>({type:'bind',source,target});
const parent=e.TEST_PARENT,legacy=e.TEST_ROOT+'/runtime/data';
const normal=()=>({name:'bellteam',services:{bellteam:{image:e.BELLTEAM_SERVER_IMAGE,
 environment:{SECRET:'synthetic-only',VALUE:'literal $$VALUE'},labels:{'fixture.$$key':'literal $$VALUE'},
 volumes:[bind(legacy,'/srv/bellteam'),bind(e.TEST_ROOT+'/runtime/home','/home/bell'),
 {type:'volume',source:'cursor-cli',target:'/home/bell/.local'},
 ...leaves.map((leaf,i)=>bind(parent+'/'+leaf,'/srv/bellteam/'+targets[i]))]}},volumes:{'cursor-cli':{name:'bellteam_cursor-cli'}}});
const current=()=>e.COMPOSE_FILE&&fs.existsSync(e.COMPOSE_FILE)?JSON.parse(fs.readFileSync(e.COMPOSE_FILE)):normal();
const event=(kind,data={})=>fs.appendFileSync(e.TEST_EVENTS,JSON.stringify({kind,args:a,composeFile:e.COMPOSE_FILE||'',project:e.COMPOSE_PROJECT_NAME||'',image:e.BELLTEAM_SERVER_IMAGE,profile:e.BELLTEAM_INTERNAL_PROFILE_FILE,cwd:process.cwd(),...data})+'\n');
const output=v=>console.log(typeof v==='string'?v:JSON.stringify(v));
event('call');
if(a[0]==='fixture-quiet'){
 const n=Number(fs.readFileSync(e.TEST_COUNT))+1;fs.writeFileSync(e.TEST_COUNT,String(n));event('quiet'+n);
 if(e.TEST_FAIL==='quiet'+n)process.exit(52);process.exit(0)
}
if(a[0]==='fixture-cursor'){event('cursor');process.exit(e.TEST_FAIL==='cursor'?9:0)}
if(a[0]==='fixture-verify'){
 event('verify');if(e.TEST_FAIL==='verify')process.exit(54);
 fs.writeFileSync(e.TEST_CHANGED,'changed after verification');process.exit(0)
}
if(a[0]==='image'){output(e.TEST_IMAGE_ID);process.exit(0)}
if(a[0]==='run'){
 if(a.includes('/bin/cat')){if(e.TEST_FAIL==='extract')process.exit(8);process.stdout.write(fs.readFileSync(e.TEST_ROOT+'/image/'+a.at(-1).slice(5)));process.exit(0)}
 if(a.includes('-e')){const i=a.indexOf('-e'),r=spawnSync(process.execPath,['-e',...a.slice(i+1)],{input:fs.readFileSync(0)});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status)}
}
if(a[0]==='compose'){
 if(a.includes('pull')&&e.TEST_FAIL==='pull')process.exit(7);
 const i=a.indexOf('-f'),file=i<0?'':a[i+1];
 if(a.includes('config')){
  if(a.includes('--images')){output(file?JSON.parse(fs.readFileSync(file)).services.bellteam.image:current().services.bellteam.image);process.exit(0)}
  if(file){const prepare=file.endsWith('compose.state-prepare.yaml'),name=prepare?'state-prepare':'state-maintenance';
   const volumes=prepare?[bind(parent,'/srv/bellteam-state-parent')]:[
    bind(legacy,'/srv/bellteam-legacy'),bind(legacy,'/srv/bellteam'),
    ...leaves.map((leaf,i)=>bind(parent+'/'+leaf,'/srv/bellteam/'+targets[i])),bind(e.TEST_ROOT+'/backups','/srv/bellteam-maintenance-backups')];
   if(!prepare&&e.TEST_FAIL==='mismatch')volumes.find(v=>v.target==='/srv/bellteam/state').source+='/other';
   output({services:{[name]:{image:e.BELLTEAM_SERVER_IMAGE,entrypoint:['/usr/bin/env','-i'],environment:{},volumes}}});process.exit(0)}
  event('normal-render');if(e.TEST_FAIL==='capture')process.exit(57);
  if(fs.existsSync(e.TEST_CHANGED))throw Error('unexpected original input reread');output(normal());process.exit(0)
 }
 if(a.includes('stop')){event('stop',{normal:current()});process.exit(0)}
 if(a.includes('up')){event('up',{normal:current()});process.exit(e.TEST_FAIL==='up'?66:0)}
 if(a.includes('run')){
  const model=JSON.parse(fs.readFileSync(file)),kind=a.at(-1)==='to-server'?'transfer':'prepare';event(kind,{model});
  if(e.TEST_FAIL===kind){fs.writeFileSync(e.TEST_PARTIAL,kind);process.exit(kind==='prepare'?61:62)}process.exit(0)
 }
}
`)
  await chmod(join(root, 'bin/docker'), 0o700)
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_ROOT: root,
    TEST_EVENTS: join(root, 'events'), TEST_COUNT: join(root, 'count'), TEST_CHANGED: join(root, 'changed'),
    TEST_PARTIAL: join(root, 'partial'), TEST_PARENT: root + '/private$KEEP', TEST_IMAGE_ID: id,
    BELLTEAM_SERVER_IMAGE: 'fixture@sha256:' + 'b'.repeat(64), BELLTEAM_DEPLOY_QUIET_EXCEPT: 'bot-fixture' }
  await writeFile(env.TEST_COUNT, '0')
  return { root, env, run: extra => exec('sh', ['scripts/deploy-image.sh'], { cwd: root, env: { ...env, ...extra } }),
    events: async () => (await readFile(env.TEST_EVENTS, 'utf8')).trim().split('\n').map(JSON.parse) }
}

test('stage2 internal: same captured normal and dedicated roots span quiet, stopped transition and startup', async t => {
  const f = await fixture(t), { stdout } = await f.run(), events = await f.events()
  assert.match(stdout, /deploy-exit=0/)
  assert.doesNotMatch(stdout, /synthetic-only/)
  assert.deepEqual(events.filter(e => ['quiet1', 'cursor', 'quiet2', 'stop', 'verify', 'prepare', 'transfer', 'up'].includes(e.kind)).map(e => e.kind),
    ['quiet1', 'cursor', 'quiet2', 'stop', 'verify', 'prepare', 'transfer', 'up'])
  assert.equal(events.filter(e => e.kind === 'normal-render').length, 1)
  const calls = events.filter(e => e.kind === 'call')
  assert.equal(calls[0].image, f.env.BELLTEAM_SERVER_IMAGE)
  assert.ok(calls.every(e => e.cwd === f.root && e.project === 'bellteam'
    && e.profile === f.root + '/src/distribution-profile.mjs' && !e.args.includes('build')))
  for (const event of calls.filter(e => e.args[0] === 'run')) {
    assert.ok(event.args.includes(id) && event.args.includes('--read-only'))
    assert.deepEqual(event.args.slice(1, 4), ['--pull', 'never', '--rm'])
    assert.ok(event.args.includes('--network') && event.args[event.args.indexOf('--network') + 1] === 'none')
  }
  assert.deepEqual(calls.at(-1).args, ['compose', 'up', '-d', '--no-build', '--pull', 'never'])
  const stop = events.find(e => e.kind === 'stop'), up = events.find(e => e.kind === 'up')
  assert.deepEqual(up.normal, stop.normal)
  assert.equal(up.normal.services.bellteam.image, id)
  assert.equal(up.normal.services.bellteam.environment.VALUE, 'literal $$VALUE')
  assert.ok(Object.hasOwn(up.normal.services.bellteam.labels, 'fixture.$key'))
  assert.deepEqual(JSON.parse(await readFile(up.composeFile, 'utf8')), up.normal)
  const maintenance = events.find(e => e.kind === 'transfer').model
  for (const kind of ['prepare', 'transfer']) {
    const event = events.find(e => e.kind === kind)
    assert.equal(event.project, 'bellteam')
    assert.equal(Object.keys(event.model.services).length, 1)
    assert.doesNotMatch(JSON.stringify(event.model), /synthetic-only|\/home\/bell/)
  }
  const prepare = events.find(e => e.kind === 'prepare').model.services['state-prepare']
  assert.equal(prepare.volumes[0].source, f.env.TEST_PARENT.replaceAll('$', () => '$$'))
  const checked = JSON.parse(JSON.stringify({ ...up.normal, services: { ...up.normal.services, ...maintenance.services } }).replaceAll('$$', '$'))
  const plan = stateWriterPlan(checked)
  for (const leaf of leaves) assert.ok(plan.roots.includes(f.env.TEST_PARENT + '/' + leaf))
  assert.ok(plan.roots.includes(f.root + '/backups'))
})

test('stage2 internal: prepare or transfer failure ends the job without later state actions', async t => {
  for (const [phase, code] of [['prepare', 61], ['transfer', 62]]) {
    const f = await fixture(t)
    await assert.rejects(f.run({ TEST_FAIL: phase }), error => error.code === code && error.stdout.includes('deploy-exit=' + code))
    const events = await f.events()
    assert.equal(events.filter(e => e.kind === phase).length, 1)
    assert.ok(!events.some(e => e.kind === 'up' || phase === 'prepare' && e.kind === 'transfer'))
    assert.equal(await readFile(f.env.TEST_PARTIAL, 'utf8'), phase)
  }
})

test('stage2 internal: capture, correspondence, quiet and writer refusal block subsequent mutations', async t => {
  for (const [phase, code, forbidden] of [['pull', 7, ['quiet1', 'cursor', 'stop']], ['extract', 8, ['quiet1', 'cursor', 'stop']],
    ['capture', 57, ['quiet1', 'stop']], ['mismatch', 1, ['quiet1', 'stop']],
    ['quiet1', 52, ['cursor', 'quiet2', 'stop']], ['cursor', 9, ['quiet2', 'stop']],
    ['quiet2', 52, ['stop']], ['verify', 54, ['prepare', 'transfer', 'up']]]) {
    const f = await fixture(t)
    await assert.rejects(f.run({ TEST_FAIL: phase }), error => error.code === code && error.stdout.includes('deploy-exit=' + code))
    assert.ok(!(await f.events()).some(e => forbidden.includes(e.kind)))
  }
})

test('stage2 internal: failed startup retains selected model and returns its actual terminal code', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ TEST_FAIL: 'up' }), error => error.code === 66 && error.stdout.includes('deploy-exit=66'))
  const up = (await f.events()).find(e => e.kind === 'up')
  assert.equal(JSON.parse(await readFile(up.composeFile, 'utf8')).services.bellteam.image, id)
})
