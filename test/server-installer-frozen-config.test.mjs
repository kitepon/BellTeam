import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile), imageId = 'sha256:' + 'a'.repeat(64)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'installer-frozen-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const install = join(root, 'install'), image = join(root, 'image'), bin = join(root, 'bin')
  for (const path of [install, join(image, 'scripts'), bin]) await mkdir(path, { recursive: true })
  await copyFile(process.env.INSTALLER_UNDER_TEST ? resolve(process.env.INSTALLER_UNDER_TEST)
    : new URL('../distribution/server/install.sh', import.meta.url), join(install, 'install.sh'))
  for (const path of ['scripts/update-cursor.sh', 'scripts/assert-state-writers-stopped.sh',
    'compose.cursor-update.yaml', 'compose.state-maintenance.json', 'compose.state-prepare.yaml'])
    await copyFile(new URL('../' + path, import.meta.url), join(image, path))
  const model = { name: 'original-project', services: { bellteam: { image: 'fixture:mutable',
    environment: { SECRET: 'synthetic-only', VALUE: 'literal $$KEEP' },
    labels: { 'fixture.$$key': 'literal $$KEEP' },
    volumes: [{ type: 'bind', source: '/original/legacy', target: '/srv/bellteam' }] } },
    volumes: { 'cursor-cli': { name: 'original-project_cursor-cli' } } }
  const modelPath = join(root, 'original.json'), events = join(root, 'events.jsonl')
  await writeFile(modelPath, JSON.stringify(model))
  await writeFile(join(bin, 'docker'), '#!' + process.execPath + '\n' + String.raw`
const fs=require('node:fs'), {spawnSync}=require('node:child_process');
const a=process.argv.slice(2), env=process.env;
const original=()=>JSON.parse(fs.readFileSync(env.TEST_MODEL));
const current=()=>env.COMPOSE_FILE&&fs.existsSync(env.COMPOSE_FILE)
  ?JSON.parse(fs.readFileSync(env.COMPOSE_FILE)):original();
const event=(kind,extra={})=>fs.appendFileSync(env.TEST_EVENTS,JSON.stringify({kind,
  composeFile:env.COMPOSE_FILE||'',project:env.COMPOSE_PROJECT_NAME||'',...extra})+'\n');
const out=v=>console.log(typeof v==='string'?v:JSON.stringify(v));
event('call',{args:a});
if(a[0]==='image'){out(env.TEST_IMAGE_ID);process.exit(0)}
if(a[0]==='compose'){
  const files=a.flatMap((v,i)=>v==='-f'?[a[i+1]]:[]);
  if(a.includes('config')){
    if(a.includes('--images')){out(files.length?JSON.parse(fs.readFileSync(files[0])).services.bellteam.image:current().services.bellteam.image);process.exit(0)}
    if(a.includes('yaml')){const c=current();out('name: '+(env.COMPOSE_PROJECT_NAME||c.name)+'\nvolumes:\n  cursor-cli:\n    name: '+c.volumes['cursor-cli'].name);process.exit(0)}
    if(files[0]==='-'){const raw=fs.readFileSync(0);event('checked',{normal:current()});process.stdout.write(raw);process.exit(0)}
    if(files.length){
      const prepare=files[0].endsWith('compose.state-prepare.yaml');
      const service=prepare?'state-prepare':'state-maintenance';
      const source=env.BELLTEAM_STATE_PARENT+(prepare?'':'/state');
      out({name:'dedicated',services:{[service]:{image:env.BELLTEAM_SERVER_IMAGE,
        entrypoint:['/usr/bin/env','-i'],environment:{},volumes:[{type:'bind',
          source:!prepare&&env.TEST_PARENT_MISMATCH?'alternate/state':source,
          target:prepare?'/srv/bellteam-state-parent':'/srv/bellteam/state'}]}}});process.exit(0)
    }
    if(!env.COMPOSE_FILE){event('original-render');if(env.TEST_NORMAL_FAILURE){process.exit(57)}}
    const c=current();if(env.TEST_MISSING_PROJECT)delete c.name;
    out(c);process.exit(0)
  }
  if(a.includes('stop')){event('stop',{normal:current()});process.exit(0)}
  if(a.includes('up')){event('up',{normal:current(),mode:fs.statSync(env.COMPOSE_FILE||env.TEST_MODEL).mode&511});process.exit(0)}
  if(a.includes('port')){out('127.0.0.1:18891');process.exit(0)}
  if(a.includes('run')){
    const file=files[0], raw=file?fs.readFileSync(file,'utf8'):'';
    const model=raw.startsWith('{')?JSON.parse(raw):null;
    event(a.at(-1),{model});process.exit(0)
  }
  process.exit(0)
}
if(a[0]==='run'){
  if(a.includes('/bin/cat')){process.stdout.write(fs.readFileSync(env.TEST_IMAGE+'/'+a.at(-1).slice('/app/'.length)));process.exit(0)}
  if(a.includes('-e')){
    const i=a.indexOf('-e'), input=fs.readFileSync(0);
    const r=spawnSync(process.execPath,['-e',a[i+1],...a.slice(i+2)],{input});
    process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status)
  }
  if(a.at(-1)==='plan'){fs.readFileSync(0);out({roots:[],volume:'original-project_cursor-cli'});process.exit(0)}
  if(a.at(-1)==='verify'){
    const c=original();c.name='changed-project';c.services.bellteam.environment.VALUE='changed';
    c.services.bellteam.volumes[0].source='/changed/legacy';fs.writeFileSync(env.TEST_MODEL,JSON.stringify(c));
    event('verified');process.exit(0)
  }
}
`)
  await chmod(join(bin, 'docker'), 0o700)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMPOSE_FILE: '', COMPOSE_PROJECT_NAME: '',
    TEST_MODEL: modelPath, TEST_IMAGE: image, TEST_IMAGE_ID: imageId, TEST_EVENTS: events,
    BELLTEAM_STATE_PARENT: '/original/private', BELLTEAM_LEGACY_DATA: '/original/legacy',
    BELLTEAM_MAINTENANCE_BACKUP_PARENT: '/original/backups' }
  return { run: extra => exec('sh', [join(install, 'install.sh')], { env: { ...env, ...extra } }),
    events: async () => (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse) }
}

test('installer uses one private frozen normal model and dedicated models after original configuration changes', async t => {
  const f = await fixture(t)
  const { stdout } = await f.run()
  const events = await f.events(), up = events.find(e => e.kind === 'up'), stop = events.find(e => e.kind === 'stop')
  assert.equal(up.project, 'original-project')
  assert.equal(up.normal.services.bellteam.image, imageId)
  assert.deepEqual(up.normal, stop.normal)
  assert.equal(up.normal.services.bellteam.volumes[0].source, '/original/legacy')
  assert.equal(up.normal.services.bellteam.environment.VALUE, 'literal $$KEEP')
  assert.ok(Object.hasOwn(up.normal.services.bellteam.labels, 'fixture.$key'))
  assert.equal(up.mode, 0o600)
  assert.equal(events.filter(e => e.kind === 'original-render').length, 1)
  for (const name of ['state-prepare', 'to-server']) {
    const event = events.find(e => e.kind === name)
    assert.equal(event.project, 'original-project')
    assert.equal(Object.keys(event.model.services).length, 1)
    assert.doesNotMatch(JSON.stringify(event.model), /synthetic-only|\/home\/bell/)
  }
  assert.doesNotMatch(stdout, /synthetic-only/)
})

test('normal capture failure occurs before stopping the server', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ TEST_NORMAL_FAILURE: '1' }), error => error.code === 57)
  assert.ok(!(await f.events()).some(e => ['stop', 'up', 'state-prepare', 'to-server'].includes(e.kind)))
})

test('inconsistent parents or missing captured project fail before stop or state mutation', async t => {
  const f = await fixture(t)
  for (const extra of [{ TEST_PARENT_MISMATCH: '1' }, { TEST_MISSING_PROJECT: '1' }])
    await assert.rejects(f.run(extra), error =>
      error.code === 1 && error.stderr.includes('SERVER_STATE_CONFIG_UNAVAILABLE'))
  assert.ok(!(await f.events()).some(e => ['stop', 'up', 'state-prepare', 'to-server'].includes(e.kind)))
})
