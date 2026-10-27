import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const exec = promisify(execFile), cid = 'c'.repeat(64), oldImage = 'sha256:' + 'd'.repeat(64)
const oldRef = 'fixture/server@sha256:' + 'b'.repeat(64), nextRef = 'fixture/server@sha256:' + 'e'.repeat(64)
const compose = resolve(process.env.TEST_COMPOSE || '../../integrations/docker-compose/bin/docker-compose')
async function fixture(t, failure = '') {
  const root = await mkdtemp(join(tmpdir(), 'original-normal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['scripts', 'bin', 'src', 'distribution/server', 'distribution/internal', 'runtime/home', 'runtime/data'])
    await mkdir(join(root, dir), { recursive: true })
  for (const [name, key] of [['deploy.sh', 'DEPLOY_UNDER_TEST'], ['deploy-image.sh', 'DEPLOY_IMAGE_UNDER_TEST']])
    await copyFile(process.env[key] || new URL('../scripts/' + name, import.meta.url), join(root, 'scripts', name))
  await writeFile(join(root, 'src/distribution-profile.mjs'), 'export const profile = "old-profile"\n')
  const files = [join(root, 'distribution/server/compose.yaml'), join(root, 'distribution/internal/compose.overlay.yaml')]
  const bind = (source, target) => ({ type: 'bind', source, target })
  await writeFile(files[0], JSON.stringify({ name: 'bellteam', services: { bellteam: {
    image: '${BELLTEAM_SERVER_IMAGE}', environment: { SECRET: '${OLD_SECRET}', VALUE: 'literal $$KEEP' },
    labels: { 'fixture.$key': 'literal $$KEEP' }, volumes: [bind(root + '/runtime/data', '/srv/bellteam'), bind(root + '/runtime/home', '/home/bell'),
      { type: 'volume', source: 'cursor-cli', target: '/home/bell/.local' }] } }, volumes: { 'cursor-cli': { external: true, name: 'bellteam_cursor-cli' } } }))
  await writeFile(files[1], JSON.stringify({ services: { bellteam: { volumes: [{ ...bind(root + '/src/distribution-profile.mjs', '/app/src/distribution-profile.mjs'), read_only: true }] } } }))
  await writeFile(join(root, '.env'), 'OLD_SECRET=irrelevant-root-env\n')
  await writeFile(join(root, 'distribution/server/.env'), 'OLD_SECRET=synthetic-original-secret\n')
  const env = { ...process.env, PATH: root + '/bin:' + process.env.PATH, TEST_ROOT: root, TEST_COMPOSE: compose,
    TEST_EVENTS: root + '/events.jsonl', TEST_FAILURE: failure, BELLTEAM_DEPLOY_IMAGE: nextRef,
    BELLTEAM_DEPLOY_QUIET_EXCEPT: 'bot-fixture', BELLTEAM_SERVER_IMAGE: oldRef }
  const explicitEnv = failure === 'explicit-env' ? ['--env-file', root + '/distribution/server/.env'] : []
  // Explicit env-file uses the repository .env in the known internal contract.
  if (failure === 'explicit-env') { await copyFile(root + '/distribution/server/.env', root + '/.env'); explicitEnv[1] = root + '/.env' }
  const originalArgs = ['-p', 'bellteam', ...files.flatMap(f => ['-f', f]), ...explicitEnv]
  const { stdout: hash } = await exec(compose, [...originalArgs, 'config', '--hash', 'bellteam'], { cwd: root, env })
  let labelFiles = files, working = dirname(files[0])
  if (failure === 'retained') {
    const retained = root + '/.bellteam-compose.LEGACY'
    await mkdir(retained, { mode: 0o700 })
    const { stdout } = await exec(compose, [...originalArgs, 'config', '--format', 'json'], { cwd: root, env })
    const model = JSON.parse(stdout.replaceAll('$$', '$'))
    await writeFile(retained + '/normal.json', JSON.stringify(model, (_key, value) => typeof value === 'string' ? value.replaceAll('$', () => '$$') : value), { mode: 0o600 })
    labelFiles = [retained + '/normal.json']; working = retained
  }
  const originalInputs = { args: originalArgs, hash: hash.trim(), files: await Promise.all(files.map(async path => ({ path, text: await readFile(path, 'utf8') }))), implicitEnv: await readFile(root + '/distribution/server/.env', 'utf8') }
  const runtime = { Id: cid, Image: oldImage, State: { Running: true, Restarting: false, StartedAt: '2026-10-27T16:03:53Z' },
    Config: { Image: oldRef, Labels: { 'com.docker.compose.project': 'bellteam',
      'com.docker.compose.project.config_files': failure === 'provenance' ? '/unknown/compose.yaml' : labelFiles.join(','),
      'com.docker.compose.project.working_dir': working,
      ...(failure === 'explicit-env' ? { 'com.docker.compose.project.environment_file': root + '/.env' } : {}),
      'com.docker.compose.config-hash': failure === 'hash' ? 'f'.repeat(64) : hash.trim().split(' ')[1] } },
    Mounts: [{ Type: 'bind', Source: root + '/runtime/data', Destination: '/srv/bellteam', RW: true },
      { Type: 'bind', Source: root + '/runtime/home', Destination: '/home/bell', RW: true },
      { Type: 'bind', Source: root + '/src/distribution-profile.mjs', Destination: '/app/src/distribution-profile.mjs', RW: false }] }
  await writeFile(root + '/runtime.json', JSON.stringify(runtime))
  const programs = {
    git: String.raw`const fs=require('node:fs'),a=process.argv.slice(2),e=process.env,r=e.TEST_ROOT;
fs.appendFileSync(e.TEST_EVENTS,JSON.stringify({tool:'git',args:a,remote:!!e.TEST_REMOTE})+'\n');
if(a[0]==='rev-parse')console.log(e.TEST_REMOTE&&!fs.existsSync(r+'/merged')?'a'.repeat(40):'e'.repeat(40));
if(a[0]==='merge') {fs.writeFileSync(r+'/merged','yes');if(fs.existsSync(r+'/distribution/server/compose.yaml'))fs.unlinkSync(r+'/distribution/server/compose.yaml');fs.writeFileSync(r+'/.env','OLD_SECRET=changed-after-FF\n');fs.writeFileSync(r+'/distribution/server/.env','OLD_SECRET=changed-after-FF\n');fs.writeFileSync(r+'/src/distribution-profile.mjs','export const profile = "new-profile"\n');}`,
    docker: String.raw`const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2),e=process.env;
fs.appendFileSync(e.TEST_EVENTS,JSON.stringify({tool:'docker',args:a})+'\n');
const r=JSON.parse(fs.readFileSync(e.TEST_ROOT+'/runtime.json'));if(e.TEST_CHANGED_CID)r.Id='f'.repeat(64);
if(a[0]==='container') {const f=a[a.indexOf('--format')+1];console.log(f==='{{json .}}'?JSON.stringify(r):f==='{{.Id}} {{.Image}}'?r.Id+' '+r.Image:f==='{{.State.StartedAt}}'?r.State.StartedAt:'volume bellteam_cursor-cli');process.exit(0)}
if(a[0]==='compose') {if(a.includes('config')){const x=cp.spawnSync(e.TEST_COMPOSE,a.slice(1),{env:e,encoding:'utf8'});process.stdout.write(x.stdout);process.stderr.write(x.stderr);process.exit(x.status)}if(a.includes('pull'))process.exit(97)}
if(a[0]==='image'&&a[1]==='save')fs.writeFileSync(a[a.indexOf('--output')+1],'synthetic-image');
if(a[0]==='exec') {if(a.includes('/bin/cat'))process.stdout.write(fs.readFileSync(e.TEST_ROOT+'/src/distribution-profile.mjs'));else if(a.includes('/usr/bin/stat'))console.log(e.TEST_FAILURE==='profile-mode'?'600':'644');else if(a.includes('/bin/tar'))process.stdout.write('synthetic-cursor');}`,
    ssh: String.raw`const fs=require('node:fs'),cp=require('node:child_process'),e=process.env,c=process.argv[3],input=c.includes('sh -s')?fs.readFileSync(0,'utf8'):'';
fs.appendFileSync(e.TEST_EVENTS,JSON.stringify({tool:'ssh',command:c,input})+'\n');
if(c.includes('sh -s')) {const x=cp.spawnSync('/bin/sh',['-s',c.split(' ').at(-1)],{cwd:e.TEST_ROOT,env:{...e,TEST_REMOTE:'1'},input,encoding:'utf8'});process.stdout.write(x.stdout.replaceAll(e.TEST_ROOT,'/home/kite/BellTeam'));process.stderr.write(x.stderr);process.exit(x.status)}
if(c.includes('git merge -q')){const x=cp.spawnSync('/bin/sh',['-c',c.replaceAll('/home/kite/BellTeam',e.TEST_ROOT)],{env:{...e,TEST_REMOTE:'1'},encoding:'utf8'});process.stdout.write(x.stdout);process.stderr.write(x.stderr);process.exit(x.status)}
if(c.includes('/api/queue'))console.log('');else if(c.includes('/healthz'))console.log('{"status":"ok"}');else if(c.includes('/api/bots'))console.log('{"bots":[]}');else if(c.includes('tail -3'))console.log('deploy-exit=0');`,
    sleep: 'process.exit(0)',
  }
  for (const [name, code] of Object.entries(programs)) { await writeFile(root + '/bin/' + name, '#!' + process.execPath + '\n' + code); await chmod(root + '/bin/' + name, 0o700) }
  const existing = root + '/.bellteam-compose.existing'; await mkdir(existing, { mode: 0o700 }); await writeFile(existing + '/sentinel', 'keep')
  return { root, env, runtime, originalInputs, run: () => exec('sh', ['scripts/deploy.sh'], { cwd: root, env }),
    adapter: extra => exec('sh', ['scripts/deploy-image.sh'], { cwd: root, env: { ...env, BELLTEAM_SERVER_IMAGE: nextRef, ...extra } }),
    events: async () => (await readFile(env.TEST_EVENTS, 'utf8')).trim().split('\n').map(JSON.parse),
    captured: async () => { const dirs = (await readdir(root)).filter(f => f.startsWith('.bellteam-compose.') && !['.bellteam-compose.existing','.bellteam-compose.LEGACY'].includes(f)); assert.equal(dirs.length, 1); return join(root, dirs[0]) } }
}

test('original normal: actual old model/image/profile survive FF and are handed to the same archived CID', async t => {
  const f = await fixture(t), { stdout } = await f.run(), saved = await f.captured()
  assert.doesNotMatch(stdout, /synthetic-original-secret/)
  const normal = JSON.parse(await readFile(saved + '/previous-normal.json', 'utf8'))
  assert.equal(normal.services.bellteam.image, oldImage)
  assert.equal(normal.services.bellteam.environment.SECRET, 'synthetic-original-secret')
  assert.ok(Object.hasOwn(normal.services.bellteam.labels, 'fixture.$key'))
  assert.equal(normal.services.bellteam.environment.VALUE, 'literal $$KEEP')
  assert.equal(await readFile(saved + '/previous-profile.mjs', 'utf8'), 'export const profile = "old-profile"\n')
  assert.equal(normal.services.bellteam.volumes.find(v => v.target === '/app/src/distribution-profile.mjs').source, saved + '/previous-profile.mjs')
  assert.equal((await stat(saved)).mode & 0o777, 0o700)
  assert.equal((await stat(saved + '/previous-normal.json')).mode & 0o777, 0o600)
  const runtime = JSON.parse(await readFile(saved + '/previous-runtime.json', 'utf8'))
  assert.equal(runtime.Id, cid); assert.equal(runtime.Image, oldImage); assert.equal(runtime.Config.Image, oldRef)
  const calls = await f.events(), launch = calls.find(c => c.command?.includes('setsid nohup'))
  assert.ok(launch.command.includes('BELLTEAM_PREVIOUS_COMPOSE=' + saved.replace(f.root, '/home/kite/BellTeam') + '/previous-normal.json'))
  assert.equal(await readFile(f.root + '/.bellteam-compose.existing/sentinel', 'utf8'), 'keep')
  await assert.rejects(f.adapter({ BELLTEAM_PREVIOUS_COMPOSE: saved + '/previous-normal.json' }), e => e.code === 97)
  const archives = await readdir(f.root + '/runtime/backups')
  const archive = archives.find(n => n.startsWith('image-before-deploy.'))
  assert.equal(await readFile(f.root + '/runtime/backups/' + archive + '/previous-compose.path', 'utf8'), saved + '/previous-normal.json\n')
  if (process.env.TEST_ORIGINAL_RECEIPT_DIR) {
    const out = process.env.TEST_ORIGINAL_RECEIPT_DIR
    await mkdir(out, { recursive: true })
    for (const file of ['previous-runtime.json','previous-model.json','previous-inputs.json','previous-normal.json','previous-profile.mjs'])
      await copyFile(saved + '/' + file, out + '/' + file)
    await writeFile(out + '/original-inputs.json', JSON.stringify(f.originalInputs, null, 2))
    await writeFile(out + '/effect-calls.json', JSON.stringify(await f.events(), null, 2))
    await writeFile(out + '/adapter-pointer.txt', await readFile(f.root + '/runtime/backups/' + archive + '/previous-compose.path'))
  }
})

test('original normal: hash, input provenance or unreadable profile refuse FF and keep private evidence', async t => {
  for (const failure of ['hash', 'provenance', 'profile-mode']) {
    const f = await fixture(t, failure)
    await assert.rejects(f.run(), e => e.code !== 0 && e.stderr.includes('BELLTEAM_ORIGINAL_CONFIG_UNAVAILABLE'))
    const calls = await f.events()
    assert.ok(!calls.some(c => c.tool === 'git' && c.args[0] === 'merge' || c.command?.includes('setsid nohup')))
    assert.equal(await readFile(f.root + '/src/distribution-profile.mjs', 'utf8'), 'export const profile = "old-profile"\n')
    const saved = await f.captured()
    assert.equal((await stat(saved + '/previous-runtime.json')).mode & 0o777, 0o600)
    assert.equal(await readFile(f.root + '/.bellteam-compose.existing/sentinel', 'utf8'), 'keep')
  }
})

test('original normal: changed old CID at adapter handoff refuses candidate work without erasing the original', async t => {
  const f = await fixture(t); await f.run(); const saved = await f.captured()
  await assert.rejects(f.adapter({ BELLTEAM_PREVIOUS_COMPOSE: saved + '/previous-normal.json', TEST_CHANGED_CID: '1' }),
    e => e.code === 1 && e.stderr.includes('BELLTEAM_PREVIOUS_CONFIG_CHANGED'))
  const calls = await f.events()
  assert.ok(!calls.some(c => c.tool === 'docker' && (c.args[0] === 'image' && c.args[1] === 'save' || c.args.includes('pull') || c.args.includes('stop'))))
  assert.equal(JSON.parse(await readFile(saved + '/previous-runtime.json', 'utf8')).Id, cid)
})


test('original normal: retained labels and explicit env-file retain their original input provenance', async t => {
  for (const kind of ['retained', 'explicit-env']) {
    const f = await fixture(t, kind)
    if (kind === 'retained') { await rm(f.root + '/distribution/server/compose.yaml'); await rm(f.root + '/distribution/server/.env') }
    await f.run(); const saved = await f.captured()
    const normal = JSON.parse(await readFile(saved + '/previous-normal.json', 'utf8'))
    assert.equal(normal.services.bellteam.environment.SECRET, 'synthetic-original-secret')
    assert.equal(normal.services.bellteam.image, oldImage)
    const inputs = JSON.parse(await readFile(saved + '/previous-inputs.json', 'utf8'))
    assert.equal(inputs.project, 'bellteam'); assert.equal(inputs.source, 'a'.repeat(40))
    assert.equal(inputs.envFile, kind === 'explicit-env' ? f.root + '/.env' : null)
    if (kind === 'retained') {
      assert.deepEqual(inputs.files, [f.root + '/.bellteam-compose.LEGACY/normal.json'])
      assert.equal(JSON.parse(await readFile(inputs.files[0], 'utf8')).services.bellteam.image, oldRef)
    }
  }
})
