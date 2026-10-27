import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, chmod, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const exec = promisify(execFile)
const image = `ghcr.io/fixture/server@sha256:${'a'.repeat(64)}`

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bellteam-image deploy-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'bin'))
  for (const name of ['deploy.sh','deploy-image.sh','check-deploy-quiet.sh','check-deploy-quiet.mjs'])
    await copyFile(name === 'deploy.sh' && process.env.DEPLOY_UNDER_TEST ? process.env.DEPLOY_UNDER_TEST
      : new URL(`../scripts/${name}`, import.meta.url), join(root,'scripts',name))
  const updater = `#!/bin/sh
docker fixture-cursor "$@"
`
  await writeFile(join(root,'fixture-updater'), updater)
  const docker = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({args,cwd:process.cwd(),
  compose:process.env.COMPOSE_FILE,project:process.env.COMPOSE_PROJECT_NAME,
  image:process.env.BELLTEAM_SERVER_IMAGE,profile:process.env.BELLTEAM_INTERNAL_PROFILE_FILE})+'\\n')
if (args[0] === 'container' && args[1] === 'inspect') console.log(args.includes('{{.Id}} {{.Image}}') ? '${'c'.repeat(64)} sha256:${'d'.repeat(64)}' : 'volume bellteam_cursor-cli')
if (args[0] === 'image' && args[1] === 'save') fs.writeFileSync(args[args.indexOf('--output')+1], 'synthetic-image')
if (args[0] === 'run') {
  if (process.env.FIXTURE_FAIL === 'extract') process.exit(8)
  process.stdout.write(args.at(-1).endsWith('update-cursor.sh') ? fs.readFileSync(process.env.FIXTURE_UPDATER) : 'services: {}\\n')
}
if (args[0] === 'exec' && args.includes('--input-type=module')) {
  const count = Number(fs.readFileSync(process.env.FIXTURE_COUNT))+1
  fs.writeFileSync(process.env.FIXTURE_COUNT, String(count))
  if (process.env.FIXTURE_FAIL === 'quiet'+count) { console.log('fixture quiet refusal'); process.exit(2) }
}
if (args[0] === 'fixture-cursor' && process.env.FIXTURE_FAIL === 'cursor') process.exit(9)
if (args[0] === 'compose' && args[1] === 'pull' && process.env.FIXTURE_FAIL === 'pull') process.exit(7)
if (args[0] === 'compose' && args[1] === 'up' && process.env.FIXTURE_FAIL === 'up') process.exit(10)
`
  await writeFile(join(root,'bin','docker'), docker)
  await chmod(join(root,'bin','docker'), 0o755)
  const env = { PATH:`${join(root,'bin')}:${process.env.PATH}`, FIXTURE_LOG:join(root,'calls'),
    FIXTURE_COUNT:join(root,'count'),FIXTURE_UPDATER:join(root,'fixture-updater'),
    BELLTEAM_SERVER_IMAGE:image,BELLTEAM_DEPLOY_QUIET_EXCEPT:'bot-fixture',TMPDIR:root }
  await writeFile(env.FIXTURE_LOG,'')
  await writeFile(env.FIXTURE_COUNT,'0')
  return {root,env,async calls(){return (await readFile(env.FIXTURE_LOG,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)}}
}

// Adapter transition/failure coverage is in deploy-state-transition.test.mjs.
test('未固定imageやquiet対象欠落はgit/SSHを始める前に拒否する',async t=>{
  const f=await fixture(t)
  for(const bin of ['git','ssh']){
    await writeFile(join(f.root,'bin',bin),'#!/bin/sh\necho unexpected >> "$FIXTURE_LOG"\nexit 98\n')
    await chmod(join(f.root,'bin',bin),0o755)
  }
  for(const [value,except] of [['fixture:latest','bot-fixture'],[image,''],['x@sha256:abc','bot-fixture']]){
    const result=await exec('sh',['scripts/deploy.sh'],{cwd:f.root,env:{...f.env,
      BELLTEAM_DEPLOY_IMAGE:value,BELLTEAM_DEPLOY_QUIET_EXCEPT:except}}).catch(error=>error)
    assert.equal(result.code,2)
  }
  assert.deepEqual(await f.calls(),[])
})

for (const selected of ['',image]) test(`正規入口は履歴/控え/結果確認を維持して${selected ? '受入image' : '従来build'}へ接続する`,async t=>{
  const f=await fixture(t)
  const sha='b'.repeat(40)
  const git=`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2)
fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({tool:'git',args})+'\\n')
if(args[0]==='rev-parse')console.log('${sha}')
`
  const ssh=`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2),command=args[1]
fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({tool:'ssh',command})+'\\n')
if(command.includes('sh -s'))console.log('/home/kite/BellTeam/.bellteam-compose.ABC123/previous-normal.json')
else if(command.includes('/api/bots'))console.log('{"bots":[]}')
else if(command.includes('/healthz'))console.log('{"status":"ok"}')
else if(command.includes('tail -3'))console.log('deploy-exit=0')
`
  for(const [name,body] of [['git',git],['ssh',ssh]]){
    await writeFile(join(f.root,'bin',name),body)
    await chmod(join(f.root,'bin',name),0o755)
  }
  const result=await exec('sh',['scripts/deploy.sh'],{cwd:f.root,env:{...f.env,BELLTEAM_DEPLOY_IMAGE:selected}})
  assert.match(result.stdout,/bots 0 online 0/u)
  const calls=await f.calls()
  assert.deepEqual(calls.filter(row=>row.tool==='git').map(row=>row.args),
    [['status','--porcelain','--untracked-files=no'],['push','-q','origin','HEAD:main'],['rev-parse','HEAD']])
  const commands=calls.filter(row=>row.tool==='ssh').map(row=>row.command)
  assert.ok(commands.some(command=>command.includes('sh -s')&&command.includes(sha)))
  assert.match(await readFile(join(f.root,'scripts/deploy.sh'),'utf8'),/git merge -q --ff-only origin\/main/)
  assert.ok(commands.some(command=>command.includes('queue-before-deploy-')))
  const launch=commands.filter(command=>command.includes('setsid nohup'))
  assert.equal(launch.length,1)
  if(selected){
    assert.ok(launch[0].includes(`BELLTEAM_SERVER_IMAGE=${image}`))
    assert.match(launch[0],/BELLTEAM_DEPLOY_QUIET_EXCEPT=bot-fixture sh scripts\/deploy-image\.sh/u)
    assert.doesNotMatch(launch[0],/compose build/u)
  }else assert.match(launch[0],/BELLTEAM_SERVER_IMAGE= BELLTEAM_DEPLOY_QUIET_EXCEPT=bot-fixture sh scripts\/deploy-image\.sh/u)
})


test('build adapter: regular deploy dispatches its empty image and selected quiet to the shared adapter once', async t => {
  const f = await fixture(t)
  for (const [name, source] of [
    ['git', "const a=process.argv.slice(2);if(a[0]==='rev-parse')console.log('" + 'b'.repeat(40) + "')"],
    ['ssh', String.raw`const fs=require('node:fs'),c=process.argv[3];fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({tool:'ssh',command:c})+'\n');
if(c.includes('sh -s'))console.log('/home/kite/BellTeam/.bellteam-compose.ABC123/previous-normal.json');else if(c.includes('/api/bots'))console.log('{"bots":[]}');else if(c.includes('/healthz'))console.log('{"status":"ok"}');else if(c.includes('tail -3'))console.log('deploy-exit=0')`],
  ]) {
    await writeFile(join(f.root, 'bin', name), '#!/usr/bin/env node\n' + source)
    await chmod(join(f.root, 'bin', name), 0o700)
  }
  await exec('sh', ['scripts/deploy.sh'], { cwd: f.root, env: { ...f.env, BELLTEAM_DEPLOY_IMAGE: '' } })
  const launches = (await f.calls()).filter(e => e.command?.includes('setsid nohup'))
  assert.equal(launches.length, 1)
  assert.match(launches[0].command, /BELLTEAM_SERVER_IMAGE= BELLTEAM_DEPLOY_QUIET_EXCEPT=bot-fixture sh scripts\/deploy-image\.sh/)
  assert.doesNotMatch(launches[0].command, /compose build|update-cursor|compose up/)
})


for (const phase of ['queue', 'health']) test('main integration: ' + phase + ' refusal blocks successful completion of shared build dispatch', async t => {
  const f = await fixture(t)
  for (const [name, source] of [
    ['git', "const a=process.argv.slice(2);if(a[0]==='rev-parse')console.log('" + 'b'.repeat(40) + "')"],
    ['ssh', String.raw`const fs=require('node:fs'),c=process.argv[3];fs.appendFileSync(process.env.FIXTURE_LOG,JSON.stringify({command:c})+'\n');
if(c.includes('queue-before-deploy')&&process.env.TEST_CONTROL==='queue')process.exit(71);
if(c.includes('sh -s'))console.log('/home/kite/BellTeam/.bellteam-compose.ABC123/previous-normal.json');else if(c.includes('/api/bots'))console.log('{"bots":[]}');else if(c.includes('/healthz'))console.log('{"status":"not-ok","reason":"ok"}');else if(c.includes('tail -3'))console.log('deploy-exit=0')`],
  ]) {
    await writeFile(join(f.root, 'bin', name), '#!/usr/bin/env node\n' + source)
    await chmod(join(f.root, 'bin', name), 0o700)
  }
  await writeFile(join(f.root, 'bin/sleep'), '#!/bin/sh\nexit 0\n')
  await chmod(join(f.root, 'bin/sleep'), 0o700)
  await assert.rejects(exec('sh', ['scripts/deploy.sh'], { cwd: f.root, env: { ...f.env, BELLTEAM_DEPLOY_IMAGE: '', TEST_CONTROL: phase } }),
    e => e.code === 1 && e.stderr.includes(phase === 'queue' ? '処理待ち一覧' : 'healthz'))
  const launches = (await f.calls()).filter(e => e.command?.includes('setsid nohup'))
  assert.equal(launches.length, phase === 'queue' ? 0 : 1)
  if (launches.length) assert.match(launches[0].command, /BELLTEAM_SERVER_IMAGE= BELLTEAM_DEPLOY_QUIET_EXCEPT=bot-fixture sh scripts\/deploy-image\.sh/)
})
