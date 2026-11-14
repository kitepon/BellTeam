import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { planResumeInstall } from '../src/resume-install-plan.mjs'
const exec = promisify(execFile), repo = fileURLToPath(new URL('..', import.meta.url))
const target = { session_id: 'offline', launch_id: 'a'.repeat(32) }
function model(name) {
  return { services: { bellteam: { environment: { AITERM_STATE_BASE: '/srv/bellteam-aiterm', LITERAL: '$unchanged' }, volumes: [
    { type: 'bind', source: '/runtime/data', target: '/srv/bellteam' }, { type: 'bind', source: '/runtime/home', target: '/home/bell' },
    { type: 'volume', source: 'cursor', target: '/home/bell/.local' },
    { type: 'volume', source: 'resume', target: '/srv/bellteam-aiterm', volume: { nocopy: true } },
  ] } }, volumes: { cursor: { name: 'cursor' }, resume: { name, external: true } } }
}
const runtime = [{ Id: 'c'.repeat(64), Image: 'sha256:' + 'd'.repeat(64) }]
test('supply plan binds distinct backing and exact old source, refuses unsupported initial preservation', () => {
  const value = planResumeInstall(model('new'), model('old'), runtime, [target], '/install/.bellteam-compose.fixed')
  assert.equal(value.plan.source_container, runtime[0].Id)
  assert.equal(value.plan.source_volume, 'old');assert.equal(value.plan.state_volume, 'new')
  assert.equal(value.normal.services.bellteam.environment.BELLTEAM_RESUME_GENERATION, '.bellteam-compose.fixed')
  assert.equal(value.normal.services.bellteam.environment.LITERAL, '$unchanged')
  assert.throws(() => planResumeInstall(model('old'), model('old'), runtime, [target], '/install/.bellteam-compose.fixed'), /BACKING_CONFLICT/)
  assert.throws(() => planResumeInstall(model('new'), null, null, [target], '/install/.bellteam-compose.fixed'), /UNAVAILABLE/)
  assert.throws(() => planResumeInstall(model('new'), model('old'), runtime, [target, target], '/install/.bellteam-compose.fixed'), /TARGET_INVALID/)
  const first = planResumeInstall(model('new'), null, null, null, '/install/.bellteam-compose.fixed')
  assert.deepEqual(first.plan.targets, []);assert.equal(first.normal.services.bellteam.environment.BELLTEAM_RESUME_GENERATION, undefined)
})

test('a reset generation name carries only the newest generation suffix', async () => {
  const grown = 'bellteam-aiterm-state' + '-bellteam-compose.Ab12Cd'.repeat(9)
  const child = execFile(process.execPath, [join(repo, 'src/resume-install-plan.mjs'), '/install/.bellteam-compose.fixed'])
  const output = new Promise((resolve, reject) => { let text = ''; child.stdout.on('data', d => { text += d }); child.on('close', code => code ? reject(code) : resolve(text)) })
  child.stdin.end(JSON.stringify([model(grown), model(grown), runtime, null]))
  const normal = JSON.parse((await output).trim().split('\n')[1])
  assert.equal(normal.volumes.resume.name, 'bellteam-aiterm-state-bellteam-compose.fixed')
})

test('preserve plan keeps the exact old backing name and refuses any other mapping or an H1 target set', () => {
  const kept = planResumeInstall(model('old'), model('old'), runtime, null, '/install/.bellteam-compose.fixed', true)
  assert.equal(kept.plan.state_volume, 'old');assert.equal(kept.plan.source_volume, 'old');assert.deepEqual(kept.plan.targets, [])
  assert.equal(kept.normal.services.bellteam.environment.BELLTEAM_AITERM_STATE_VOLUME, 'old')
  assert.equal(kept.normal.services.bellteam.environment.BELLTEAM_RESUME_GENERATION, undefined)
  const home = model('old');home.services.bellteam.volumes[1].source = '/elsewhere/home'
  for (const [normal, previous, source, targets, error] of [[model('new'), model('old'), runtime, null, /PRESERVE_UNCONFIRMED/],
    [model('old'), model('old'), runtime, [target], /PRESERVE_UNCONFIRMED/], [model('old'), null, null, null, /PRESERVE_UNCONFIRMED/],
    [model('old'), model('old'), [{ Id: 'x', Image: runtime[0].Image }], null, /SOURCE_UNCONFIRMED/], [model('old'), home, runtime, null, /SOURCE_UNCONFIRMED/]])
    assert.throws(() => planResumeInstall(normal, previous, source, targets, '/install/.bellteam-compose.fixed', true), error)
})

test('installer extracts H1 scripts only from the common public/internal image locations', async () => {
  const installer = await readFile(join(repo, 'distribution/server/install.sh'), 'utf8')
  const helper = await readFile(join(repo, 'distribution/server/install-resume-state.sh'), 'utf8')
  assert.match(installer, /\/app\/install-resume-state\.sh/)
  assert.doesNotMatch(installer, /\/app\/distribution\/server\/install-resume-state/)
  assert.match(helper, /for path in compose\.aiterm-checkpoint\.yaml/)
  assert.doesNotMatch(helper, /for path in distribution\/server\/compose\.aiterm/)
})

const fakeDocker = `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
const a=process.argv.slice(2),e=process.env;fs.appendFileSync(e.TEST_ROOT+'/calls',JSON.stringify(a)+'\\n');
if(a[0]==='container'&&a[1]==='inspect'){console.log(e.TEST_STOP_PROOF);process.exit(0)}
if(e.TEST_PREPARE){
 if(a[0]==='volume'){
  if(a[1]==='create')process.exit(0);
  if(a.includes('--format'))console.log(e.TEST_VOLUME_METADATA||a.at(-1)+' local 0 synthetic aiterm-state');
  process.exit(0);
 }
 if(a.includes('/app/src/resume-install-plan.mjs')){
  const r=spawnSync(process.execPath,[e.TEST_REPO+'/src/resume-install-plan.mjs',a.at(-1)],{stdio:'inherit'});process.exit(r.status??1);
 }
 if(a.includes('/bin/cat')){process.stdout.write(fs.readFileSync(e.TEST_REPO+'/distribution/server/compose.aiterm-checkpoint.yaml'));process.exit(0)}
 if(a[0]==='compose'){
  const m=JSON.parse(fs.readFileSync(a[a.indexOf('-f')+1]));
  m.services['aiterm-checkpoint'].image='synthetic-image';
  m.volumes['aiterm-state'].name=e.BELLTEAM_AITERM_STATE_VOLUME;
  m.services['aiterm-checkpoint'].volumes[1].source=e.BELLTEAM_AITERM_CHECKPOINT_HOME;
  console.log(JSON.stringify(m));process.exit(0);
 }
 if(a.includes('-e')&&a[a.indexOf('-e')+1].includes('aiterm-resume-state')){
  const old=a.includes('sha256:'+'d'.repeat(64));process.exit(e.TEST_CLI_MISSING===(old?'old':'new')?1:0);
 }
 if(a.includes('-e')&&a[a.indexOf('-e')+1].includes('fs.chownSync')){
  const code=a[a.indexOf('-e')+1].replace('p="/resume-state"','p='+JSON.stringify(e.TEST_ROOT+'/volume'));
  const r=spawnSync(process.execPath,['-e','require("fs").chownSync=(p,u,g)=>{if(u!==1000||g!==1000)process.exit(92)};'+code],{stdio:'inherit'});process.exit(r.status??1);
 }
}
if(a[0]==='run'&&a.includes('-e')){
 const args=a.slice(a.indexOf('-e')),mount=a[a.indexOf('--mount')+1];
 if(a.includes('--mount')&&mount?.includes('target=/resume-plan'))args[1]=args[1].replaceAll('/resume-plan/',mount.match(/source=([^,]+)/)[1]+'/');
 const r=spawnSync(process.execPath,args,{stdio:'inherit'});process.exit(r.status??1)
}
if(a.includes('aiterm-checkpoint')){
 const b=Buffer.from('{"fixture":"private-only"}\\n');process.stdout.on('error',()=>{});process.stdout.write(b);
 if(e.TEST_PRODUCER_FAIL){process.stderr.write('aiterm: RESUME_STATE_UNCONFIRMED\\n');process.exitCode=2}
 else process.stderr.write(JSON.stringify({schema:'aiterm.resume-state-result.v1',operation:'checkpoint',session_id:a[a.indexOf('--session')+1],launch_id:a[a.indexOf('--launch')+1],checkpoint_sha256:createHash('sha256').update(b).digest('hex'),outcome:'saved'})+'\\n');
}else if(a.includes('/app/src/run-resume-store.mjs')){
 if(a[a.indexOf('--user')+1]!=='1001:1001')process.exit(91);
 if(e.TEST_RECEIVER_FAIL)process.exit(4);
 const i=a.indexOf('/app/src/run-resume-store.mjs'),[mode,generation,session_id,launch_id]=a.slice(i+1);
 if(mode==='stage')process.stdout.write('READY\\n');
 const {receiveResumeInput}=await import(pathToFileURL(e.TEST_REPO+'/src/resume-storage.mjs'));
 try{await receiveResumeInput(e.TEST_ROOT+'/private',mode,generation,{session_id,launch_id},fs.readFileSync(0))}catch{process.exitCode=1}
}else process.exit(98);
`
test('installer pipe checks both exits and publishes only validated private generations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-h1-install-'));t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await mkdir(join(root, 'bin'));await writeFile(join(root, 'bin/docker'), fakeDocker, { mode: 0o700 })
  for (const failure of [null, 'TEST_PRODUCER_FAIL', 'TEST_RECEIVER_FAIL']) {
    const work = join(root, failure ?? 'success'), saved = join(work, '.bellteam-compose.fixed'), staging = join(work, 'staging')
    await mkdir(saved, { recursive: true });await mkdir(staging)
    const { plan } = planResumeInstall(model('new'), model('old'), runtime, [target], saved)
    await writeFile(join(saved, 'resume-plan.json'), JSON.stringify(plan))
    await writeFile(join(saved, 'stopped-runtime.json'), JSON.stringify({ source_container: plan.source_container,
      source_image: plan.source_image, source_volume: plan.source_volume, stopped: true, restart_policy: 'no' }))
    const env = { PATH: join(root, 'bin') + ':' + dirname(process.execPath) + ':/usr/bin:/bin', TEST_ROOT: work, TEST_REPO: repo,
      saved, staging, image: 'synthetic-image', project: 'synthetic', resume_count: '1', resume_generation: '.bellteam-compose.fixed',
      ...(failure ? { [failure]: '1' } : {}) }
    const run = exec('sh', ['-ec', '. "$TEST_REPO/distribution/server/install-resume-state.sh";resume_capture'], { env })
    if (failure) await assert.rejects(run)
    else await run
    const output = join(work, 'private/.bellteam-compose.fixed/generation.json')
    if (failure) await assert.rejects(readFile(output), { code: 'ENOENT' })
    else {
      const completed = JSON.parse(await readFile(output));assert.equal(completed.targets.length, 1)
      const calls = (await readFile(join(work, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse)
      const store = calls.filter(a => a.includes('/app/src/run-resume-store.mjs'))
      assert.deepEqual(store.map(a => a[a.indexOf('/app/src/run-resume-store.mjs') + 1]), ['stage', 'finish', 'generation'])
      assert.equal((await readdir(dirname(output))).some(n => n.endsWith('.pending')), false)
    }
  }
})

test('stopped CID evidence is bound before rm and rejects a changed CID, live PID or restart policy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-h1-stop-'));t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await mkdir(join(root, 'bin'));await writeFile(join(root, 'bin/docker'), fakeDocker, { mode: 0o700 })
  const saved = join(root, '.bellteam-compose.fixed');await mkdir(saved)
  const { plan } = planResumeInstall(model('new'), model('old'), runtime, [target], saved)
  await writeFile(join(saved, 'resume-plan.json'), JSON.stringify(plan))
  const expected = `${plan.source_container} ${plan.source_image} 0 false false no`
  for (const proof of [expected, expected.replace(plan.source_container, 'e'.repeat(64)),
    expected.replace(' 0 ', ' 123 '), expected.replace(' false false no', ' false false unless-stopped')]) {
    const env = { PATH: join(root, 'bin') + ':' + dirname(process.execPath) + ':/usr/bin:/bin', TEST_ROOT: root, TEST_REPO: repo,
      saved, image: 'synthetic-image', resume_count: '1', stopped_container: plan.source_container, TEST_STOP_PROOF: proof }
    const run = exec('sh', ['-ec', '. "$TEST_REPO/distribution/server/install-resume-state.sh";resume_stopped'], { env })
    if (proof === expected) {
      await run;assert.equal(JSON.parse(await readFile(join(saved, 'stopped-runtime.json'))).source_container, plan.source_container)
    } else await assert.rejects(run)
  }
})


test('preparation binds the real helper model and refuses missing CLI or volume identity before stopping', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-h1-prepare-'));t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await mkdir(join(root, 'bin'));await writeFile(join(root, 'bin/docker'), fakeDocker, { mode: 0o700 })
  for (const failure of [null, 'new', 'old', 'volume']) {
    const work = join(root, failure ?? 'success'), saved = join(work, '.bellteam-compose.fixed'), staging = join(work, 'staging')
    await mkdir(saved, { recursive: true });await mkdir(staging);await mkdir(join(work, 'volume'))
    for (const [name, value] of Object.entries({ normal: model('new'), 'previous-normal': model('new'), 'previous-runtime': runtime }))
      await writeFile(join(saved, name + '.json'), JSON.stringify(value))
    const targets = join(work, 'targets.json');await writeFile(targets, JSON.stringify([target]))
    const env = { PATH: join(root, 'bin') + ':' + dirname(process.execPath) + ':/usr/bin:/bin', TEST_ROOT: work, TEST_REPO: repo,
      TEST_PREPARE: '1', BELLTEAM_RESUME_TARGETS_FILE: targets, saved, staging, image: 'synthetic-image', project: 'synthetic',
      ...(failure === 'volume' ? { TEST_VOLUME_METADATA: 'new local 1 synthetic aiterm-state' } : { TEST_CLI_MISSING: failure ?? '' }) }
    const run = exec('sh', ['-ec', '. "$TEST_REPO/distribution/server/install-resume-state.sh";resume_prepare'], { env })
    if (failure) await assert.rejects(run)
    else {
      await run
      const helper = JSON.parse(await readFile(join(saved, 'checkpoint.json')))
      assert.equal(helper.services['aiterm-checkpoint'].image, 'synthetic-image')
      assert.equal(helper.services['aiterm-checkpoint'].volumes[1].source, '/runtime/home')
      assert.equal(helper.volumes['aiterm-state'].name, 'new')
      assert.deepEqual(JSON.parse(await readFile(join(saved, 'previous-normal.json'))), model('new'))
      assert.equal(helper.services['aiterm-checkpoint'].volumes.every(m => m.read_only), true)
      const normal = JSON.parse(await readFile(join(saved, 'normal.json')))
      assert.equal(normal.services.bellteam.environment.BELLTEAM_AITERM_STATE_VOLUME, 'new-bellteam-compose.fixed')
      const calls = (await readFile(join(work, 'calls'), 'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(calls.some(a => a.includes('--cap-add')), false, 'no destination mutation before writer inspection')
      assert.equal(calls.some(a => a[0] === 'stop' || a[0] === 'rm' || a[0] === 'update'), false)
      const init = ['-ec', '. "$TEST_REPO/distribution/server/install-resume-state.sh";resume_volume=new;resume_initialize']
      await exec('sh', init, { env })
      await writeFile(join(work, 'volume', 'existing'), 'keep')
      await assert.rejects(exec('sh', init, { env }), 'a populated destination is never reset')
      assert.equal(await readFile(join(work, 'volume', 'existing'), 'utf8'), 'keep')
    }
  }
  const installer = await readFile(join(repo, 'distribution/server/install.sh'), 'utf8')
  assert.ok(installer.indexOf('sh "$staging/scripts/assert-state-writers-stopped.sh" --maintenance') < installer.indexOf('then resume_initialize;fi'))
})
