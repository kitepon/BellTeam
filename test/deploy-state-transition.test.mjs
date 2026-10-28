import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
 environment:{SECRET:'synthetic-only',VALUE:'literal $$VALUE',BELLTEAM_NORMAL_ADMISSION_TOKEN:e.BELLTEAM_NORMAL_ADMISSION_TOKEN},labels:{'fixture.$$key':'literal $$VALUE'},
 volumes:[bind(legacy,'/srv/bellteam'),bind(e.TEST_ROOT+'/runtime/home','/home/bell'),
 {type:'volume',source:'cursor-cli',target:'/home/bell/.local'},
 {type:'bind',source:'/home/kite/BellTeam/runtime/server-only/maintenance-control',target:'/run/bellteam-maintenance',read_only:true,bind:{create_host_path:false}},
 ...leaves.map((leaf,i)=>bind(parent+'/'+leaf,'/srv/bellteam/'+targets[i]))]}},volumes:{'cursor-cli':{name:'bellteam_cursor-cli'}}});
const current=()=>e.COMPOSE_FILE&&fs.existsSync(e.COMPOSE_FILE)?JSON.parse(fs.readFileSync(e.COMPOSE_FILE)):normal();
const event=(kind,data={})=>fs.appendFileSync(e.TEST_EVENTS,JSON.stringify({kind,args:a,composeFile:e.COMPOSE_FILE||'',project:e.COMPOSE_PROJECT_NAME||'',image:e.BELLTEAM_SERVER_IMAGE,profile:e.BELLTEAM_INTERNAL_PROFILE_FILE,cwd:process.cwd(),...data})+'\n');
const output=v=>console.log(typeof v==='string'?v:JSON.stringify(v));
event('call');
if(a[0]==='stop'){event('stop',{normal:current()});process.exit(e.TEST_FAIL==='stop'?53:0)}
if(a[0]==='fixture-quiet'){
 const n=Number(fs.readFileSync(e.TEST_COUNT))+1;fs.writeFileSync(e.TEST_COUNT,String(n));event('quiet'+n);
 if(e.TEST_FAIL==='quiet'+n)process.exit(52);process.exit(0)
}
if(a[0]==='fixture-cursor'){event('cursor');process.exit(e.TEST_FAIL==='cursor'?9:0)}
if(a[0]==='fixture-verify'){
 event('verify',{stoppedContainer:e.BELLTEAM_STOPPED_CONTAINER_ID});if(e.TEST_FAIL==='verify')process.exit(54);
 fs.writeFileSync(e.TEST_CHANGED,'changed after verification');process.exit(0)
}
if(a[0]==='container'){
 output(a.includes('{{.Id}} {{.Image}}')?'c'.repeat(64)+' sha256:'+'d'.repeat(64):a.includes('{{.State.StartedAt}}')?'2026-10-27T16:03:53Z':'volume bellteam_cursor-cli');process.exit(0)
}
if(a[0]==='image'&&a[1]==='save'){
 fs.writeFileSync(a[a.indexOf('--output')+1],'synthetic-image');event('archive-image');process.exit(e.TEST_FAIL==='archive-image'?73:0)
}
if(a[0]==='exec'&&a.includes('/bin/tar')){
 process.stdout.write('synthetic-cursor');event('archive-cursor');process.exit(e.TEST_FAIL==='archive-cursor'?74:0)
}
if(a[0]==='image'){if(e.TEST_FAIL==='built-image')process.exit(72);output(e.TEST_IMAGE_ID);process.exit(0)}
if(a[0]==='run'){
 if(a.includes('/bin/cat')){if(e.TEST_FAIL==='extract')process.exit(8);process.stdout.write(fs.readFileSync(e.TEST_ROOT+'/image/'+a.at(-1).slice(5)));process.exit(0)}
 if(a.includes('-e')){const i=a.indexOf('-e');if(e.TEST_FAIL==='recovery-publish')fs.mkdirSync(a[i+3]+'/recovery.json.tmp');const r=spawnSync(process.execPath,['-e',...a.slice(i+1)],{input:fs.readFileSync(0)});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status)}
}
if(a[0]==='compose'){
 if(a.includes('ps')){output(e.TEST_NORMAL_CID??'c'.repeat(64));process.exit(0)}
 if(a.includes('build')){event('build');process.exit(e.TEST_FAIL==='build'?71:0)}
 if(a.includes('pull')&&e.TEST_FAIL==='pull')process.exit(7);
 const i=a.indexOf('-f'),file=i<0?'':a[i+1];
 if(a.includes('config')){
  if(a.includes('--images')){output(file?JSON.parse(fs.readFileSync(file)).services.bellteam.image:current().services.bellteam.image||'bellteam-bellteam');process.exit(0)}
  if(file){const prepare=file.endsWith('compose.state-prepare.yaml'),name=prepare?'state-prepare':'state-maintenance';
   const volumes=prepare?[bind(parent,'/srv/bellteam-state-parent')]:[
    bind(legacy,'/srv/bellteam-legacy'),bind(legacy,'/srv/bellteam'),
    ...leaves.map((leaf,i)=>bind(parent+'/'+leaf,'/srv/bellteam/'+targets[i])),bind(e.TEST_ROOT+'/backups','/srv/bellteam-maintenance-backups')];
   if(!prepare&&e.TEST_FAIL==='mismatch')volumes.find(v=>v.target==='/srv/bellteam/state').source+='/other';
   output({services:{[name]:{image:e.BELLTEAM_SERVER_IMAGE,entrypoint:['/usr/bin/env','-i'],environment:{},volumes}}});process.exit(0)}
  event('normal-render');if(e.TEST_FAIL==='capture')process.exit(57);
  if(fs.existsSync(e.TEST_CHANGED))throw Error('unexpected original input reread');const n=normal();if(e.TEST_FAIL==='target-nested')n.services.bellteam.volumes.push(bind(e.TEST_ROOT+'/other','/srv/bellteam/state/hidden'));output(n);process.exit(0)
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


test('build adapter: local build enters the same frozen stopped state transition without registry pull', async t => {
  const f = await fixture(t)
  const { stdout } = await f.run({ BELLTEAM_SERVER_IMAGE: '' })
  assert.match(stdout, /deploy-exit=0/)
  const events = await f.events(), calls = events.filter(e => e.kind === 'call')
  const build = calls.find(e => e.args.includes('build'))
  assert.deepEqual(build.args, ['compose', 'build', '--pull', '--no-cache'])
  assert.equal(build.composeFile, f.root + '/compose.yaml')
  assert.ok(!calls.some(e => e.args[0] === 'compose' && e.args.includes('pull')))
  assert.deepEqual(events.filter(e => ['build', 'quiet1', 'cursor', 'quiet2', 'stop', 'verify', 'prepare', 'transfer', 'up'].includes(e.kind)).map(e => e.kind),
    ['build', 'quiet1', 'cursor', 'quiet2', 'stop', 'verify', 'prepare', 'transfer', 'up'])
  const up = events.find(e => e.kind === 'up')
  assert.equal(up.normal.services.bellteam.image, id)
  assert.deepEqual(up.normal, events.find(e => e.kind === 'stop').normal)
  assert.equal(JSON.parse(await readFile(up.composeFile, 'utf8')).services.bellteam.image, id)
})

test('build adapter: build and local image selection failures leave the running service untouched', async t => {
  for (const [phase, code] of [['build', 71], ['built-image', 72]]) {
    const f = await fixture(t)
    await assert.rejects(f.run({ BELLTEAM_SERVER_IMAGE: '', TEST_FAIL: phase }), error =>
      error.code === code && error.stdout.includes('deploy-exit=' + code))
    assert.ok(!(await f.events()).some(e => ['quiet1', 'cursor', 'stop', 'prepare', 'transfer', 'up'].includes(e.kind)))
  }
})

test('build adapter: legacy optional quiet remains optional while stopped state migration still runs', async t => {
  const f = await fixture(t)
  await f.run({ BELLTEAM_SERVER_IMAGE: '', BELLTEAM_DEPLOY_QUIET_EXCEPT: '' })
  const events = await f.events()
  assert.ok(!events.some(e => e.kind.startsWith('quiet')))
  assert.deepEqual(events.filter(e => ['build', 'cursor', 'stop', 'verify', 'prepare', 'transfer', 'up'].includes(e.kind)).map(e => e.kind),
    ['build', 'cursor', 'stop', 'verify', 'prepare', 'transfer', 'up'])
})


test('recovery model: internal success and failed startup preserve the exact dedicated migration model', async t => {
  for (const fail of ['', 'up']) {
    const f = await fixture(t)
    if (fail) await assert.rejects(f.run({ TEST_FAIL: fail }), e => e.code === 66)
    else await f.run()
    const events = await f.events(), up = events.find(e => e.kind === 'up')
    const saved = JSON.parse(await readFile(join(dirname(up.composeFile), 'compose.state-maintenance.json'), 'utf8'))
    assert.deepEqual(saved, events.find(e => e.kind === 'transfer').model)
    assert.equal(saved.services['state-maintenance'].image, id)
    assert.doesNotMatch(JSON.stringify(saved), /synthetic-only|\/home\/bell/)
    assert.equal(events.filter(e => e.kind === 'transfer').length, 1)
  }
})


test('main integration: actual-old-CID archive preservation precedes the stage2 transition and failures block it', async t => {
  const f = await fixture(t), { stdout } = await f.run(), events = await f.events()
  const previous = stdout.match(/previous-image=(.+)/)[1]
  for (const file of ['image.tar', 'cursor.tar']) {
    const path = join(f.root, previous, file), bytes = await readFile(path)
    assert.ok((await readFile(path + '.sha256', 'utf8')).startsWith(createHash('sha256').update(bytes).digest('hex') + ' '))
  }
  assert.deepEqual(events.filter(e => ['archive-image', 'archive-cursor', 'quiet1', 'stop', 'prepare', 'transfer', 'up'].includes(e.kind)).map(e => e.kind),
    ['archive-image', 'archive-cursor', 'quiet1', 'stop', 'prepare', 'transfer', 'up'])
  const cursor = events.find(e => e.args[0] === 'exec' && e.args.includes('/bin/tar'))
  assert.ok(cursor.args.includes('c'.repeat(64)))
  for (const [phase, code] of [['archive-image', 73], ['archive-cursor', 74]]) {
    const broken = await fixture(t)
    await assert.rejects(broken.run({ TEST_FAIL: phase }), e => e.code === code && e.stdout.includes('deploy-exit=' + code))
    assert.ok(!(await broken.events()).some(e => ['normal-render', 'quiet1', 'stop', 'prepare', 'transfer', 'up'].includes(e.kind)))
  }
})


async function originalPair(t, layout = 'legacy', mismatch = '') {
  const f = await fixture(t), previous = join(f.root, '.bellteam-compose.OLD123')
  await mkdir(previous, { mode: 0o700 }); await mkdir(join(f.root, 'src'))
  await copyFile(new URL('../src/server-state-writers.mjs', import.meta.url), join(f.root, 'src/server-state-writers.mjs'))
  const bind = (source, target) => ({ type: 'bind', source, target })
  const normal = { name: 'bellteam', services: { bellteam: { image: 'sha256:' + 'd'.repeat(64),
    environment: { SECRET: 'synthetic-original-secret' }, labels: { 'old.$key': 'literal $VALUE' },
    volumes: [bind(f.root + '/runtime/data', '/srv/bellteam'), bind(f.root + '/runtime/home', '/home/bell'),
      { type: 'volume', source: 'cursor-cli', target: '/home/bell/.local' },
      ...(layout === 'server' ? leaves.map((leaf, i) => bind(f.env.TEST_PARENT + '/' + leaf, '/srv/bellteam/' + targets[i])) : [])] } },
    volumes: { 'cursor-cli': { name: 'bellteam_cursor-cli' } } }
  if (mismatch === 'data') normal.services.bellteam.volumes[0].source += '/different'
  if (mismatch === 'home') normal.services.bellteam.volumes[1].source += '/different'
  if (mismatch === 'volume') normal.volumes['cursor-cli'].name = 'different_cursor'
  if (mismatch === 'state') normal.services.bellteam.volumes.at(-1).source += '/different'
  if (mismatch === 'nested') normal.services.bellteam.volumes.push(bind(f.root + '/other', '/srv/bellteam/state/hidden'))
  const file = previous + '/previous-normal.json'
  await writeFile(file, JSON.stringify(normal, (_key, value) => typeof value === 'string' ? value.replaceAll('$', () => '$$') : value), { mode: 0o600 })
  await writeFile(previous + '/previous-runtime.json', JSON.stringify({ Id: 'c'.repeat(64), Image: normal.services.bellteam.image,
    State: { StartedAt: '2026-10-27T16:03:53Z' } }), { mode: 0o600 })
  return { ...f, previous, originalFile: file, run: extra => f.run({ BELLTEAM_PREVIOUS_COMPOSE: file, ...extra }) }
}

test('recovery pair: legacy original and image archive stay with the selected normal on success and failed startup', async t => {
  for (const phase of ['', 'up']) {
    const f = await originalPair(t)
    const outcome = await f.run({ TEST_FAIL: phase }).catch(e => e)
    if (phase) assert.equal(outcome.code, 66)
    const events = await f.events(), up = events.find(e => e.kind === 'up'), saved = dirname(up.composeFile)
    const recovery = JSON.parse(await readFile(saved + '/recovery.json', 'utf8'))
    assert.equal(recovery.previousCompose, f.originalFile); assert.equal(recovery.stateLayout, 'legacy')
    assert.equal(await readFile(recovery.previousImageArchive + '/previous-compose.path', 'utf8'), f.originalFile + '\n')
    assert.equal(JSON.parse(await readFile(f.originalFile, 'utf8')).services.bellteam.image, 'sha256:' + 'd'.repeat(64))
    assert.equal(JSON.parse(await readFile(saved + '/compose.state-maintenance.json', 'utf8')).services['state-maintenance'].image, id)
    assert.equal((await stat(saved + '/recovery.json')).mode & 0o777, 0o600)
    assert.match(outcome.stdout, new RegExp('saved-compose=' + saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(outcome.stdout, /synthetic-original-secret/)
    assert.ok(!events.some(e => e.args.includes('to-legacy')))
    if (!phase && process.env.TEST_RECOVERY_RECEIPT_DIR) {
      const out = process.env.TEST_RECOVERY_RECEIPT_DIR
      await mkdir(out, { recursive: true })
      for (const name of ['normal.json','compose.state-maintenance.json','recovery.json']) await copyFile(saved + '/' + name, out + '/' + name)
      await copyFile(f.originalFile, out + '/previous-normal.json')
      await writeFile(out + '/effect-calls.json', JSON.stringify(events, null, 2))
      await writeFile(out + '/result.stdout', outcome.stdout)
    }
  }
})

test('recovery pair: same private state is classified separately without requesting inverse relocation', async t => {
  const f = await originalPair(t, 'server'); await f.run()
  const up = (await f.events()).find(e => e.kind === 'up')
  const recovery = JSON.parse(await readFile(dirname(up.composeFile) + '/recovery.json', 'utf8'))
  assert.equal(recovery.stateLayout, 'server'); assert.equal(recovery.previousCompose, f.originalFile)
  assert.ok(!Object.hasOwn(recovery, 'toLegacy'))
})

test('recovery pair: incompatible views or cursor refuse quiet, Cursor and stop without changing the original', async t => {
  for (const kind of ['data', 'home', 'volume', 'state', 'nested', 'target-nested']) {
    const f = await originalPair(t, kind === 'state' ? 'server' : 'legacy', kind)
    const original = await readFile(f.originalFile)
    await assert.rejects(f.run({ TEST_FAIL: kind }), e => e.code === 1 && e.stderr.includes('BELLTEAM_RECOVERY_PAIR_UNAVAILABLE'))
    assert.ok(!(await f.events()).some(e => ['quiet1', 'cursor', 'stop', 'prepare', 'transfer', 'up'].includes(e.kind)))
    assert.deepEqual(await readFile(f.originalFile), original)
    assert.deepEqual((await readdir(f.root)).filter(n => n.startsWith('.bellteam-compose.')), ['.bellteam-compose.OLD123'])
  }
})

test('recovery pair: failed private publication removes only the new target and leaves original and archive intact', async t => {
  const f = await originalPair(t), original = await readFile(f.originalFile)
  await assert.rejects(f.run({ TEST_FAIL: 'recovery-publish' }), e => e.code === 1 && e.stderr.includes('BELLTEAM_RECOVERY_PAIR_UNAVAILABLE'))
  assert.ok(!(await f.events()).some(e => ['quiet1', 'cursor', 'stop', 'prepare', 'transfer', 'up'].includes(e.kind)))
  assert.deepEqual(await readFile(f.originalFile), original)
  assert.deepEqual((await readdir(f.root)).filter(n => n.startsWith('.bellteam-compose.')), ['.bellteam-compose.OLD123'])
  const backups = await readdir(f.root + '/runtime/backups')
  assert.equal(await readFile(f.root + '/runtime/backups/' + backups[0] + '/previous-compose.path', 'utf8'), f.originalFile + '\n')
})


test('writer restart: internal adapter hands the exact pre-stop normal CID to the checker', async t => {
  const f = await fixture(t); await f.run(); const events = await f.events()
  assert.equal(events.find(e => e.kind === 'verify').stoppedContainer, 'c'.repeat(64))
  const ps = events.findIndex(e => e.args[0] === 'compose' && e.args.includes('ps'))
  assert.ok(ps >= 0 && ps < events.findIndex(e => e.kind === 'stop'))
})

test('exact stop: internal adapter targets the captured CID, skips absent normal and refuses failed stop', async t => {
  const f = await fixture(t); await f.run()
  assert.deepEqual((await f.events()).filter(e => e.kind === 'stop').map(e => e.args), [['stop', 'c'.repeat(64)]])
  await writeFile(f.env.TEST_EVENTS, ''); await writeFile(f.env.TEST_COUNT, '0'); await rm(f.env.TEST_CHANGED)
  await f.run({ TEST_NORMAL_CID: '' })
  assert.equal((await f.events()).filter(e => e.kind === 'stop').length, 0)
  await writeFile(f.env.TEST_EVENTS, ''); await writeFile(f.env.TEST_COUNT, '0'); await rm(f.env.TEST_CHANGED)
  await assert.rejects(f.run({ TEST_FAIL: 'stop' }), e => e.code === 53)
  assert.ok(!(await f.events()).some(e => ['verify', 'prepare', 'transfer', 'up'].includes(e.kind)))
})
