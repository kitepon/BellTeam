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
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root,'scripts',name))
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
if (args[0] === 'container' && args[1] === 'inspect') console.log('${'c'.repeat(64)} sha256:${'d'.repeat(64)}')
if (args[0] === 'image' && args[1] === 'save') fs.writeFileSync(args[args.indexOf('--output')+1], 'synthetic-image')
if (args[0] === 'run') {
  if (process.env.FIXTURE_FAIL === 'extract') process.exit(8)
  process.stdout.write(args.at(-1).endsWith('update-cursor.sh') ? fs.readFileSync(process.env.FIXTURE_UPDATER) : 'services: {}\\n')
}
if (args[0] === 'exec') {
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

test('商用imageは同じdigest・構成で取得し、旧本体のquiet2点を挟んで一度だけupする', async t => {
  const f = await fixture(t)
  const { stdout } = await exec('sh',['scripts/deploy-image.sh'],{cwd:f.root,env:f.env})
  assert.match(stdout,/deploy-exit=0/u)
  const calls = await f.calls()
  assert.deepEqual(calls.map(row => row.args[0] === 'compose' ? row.args[1] : row.args[0]),
    ['container','image','pull','run','run','exec','fixture-cursor','exec','up'])
  for (const row of calls) {
    assert.equal(row.cwd,f.root)
    assert.equal(row.compose,`${f.root}/distribution/server/compose.yaml:${f.root}/distribution/internal/compose.overlay.yaml`)
    assert.equal(row.project,'bellteam');assert.equal(row.image,image)
    assert.equal(row.profile,`${f.root}/src/distribution-profile.mjs`)
  }
  for (const row of calls.filter(row=>row.args[0]==='run')) {
    assert.ok(row.args.includes(image));assert.ok(row.args.includes('--read-only'))
    assert.deepEqual(row.args.slice(1,5),['--pull','never','--rm','--network'])
  }
  assert.deepEqual(calls.at(-1).args,['compose','up','-d','--no-build','--pull','never'])
  assert.equal(calls.some(row=>row.args.includes('stop')||row.args.includes('build')),false)
})

for (const [failure,code,quiet,cursor,up] of [
  ['pull',7,0,0,0],['extract',8,0,0,0],['quiet1',2,1,0,0],
  ['cursor',9,1,1,0],['quiet2',2,2,1,0],['up',10,2,1,1],
]) test(`${failure}失敗は記録し、未実行の更新・upや旧本体stopを行わない`,async t=>{
  const f=await fixture(t)
  const result=await exec('sh',['scripts/deploy-image.sh'],{cwd:f.root,env:{...f.env,FIXTURE_FAIL:failure}}).catch(error=>error)
  assert.equal(result.code,code);assert.match(result.stdout,new RegExp(`deploy-exit=${code}`,'u'))
  const calls=await f.calls()
  assert.equal(calls.filter(row=>row.args[0]==='exec').length,quiet)
  assert.equal(calls.filter(row=>row.args[0]==='fixture-cursor').length,cursor)
  assert.equal(calls.filter(row=>row.args[0]==='compose'&&row.args[1]==='up').length,up)
  assert.equal(calls.some(row=>row.args.includes('stop')||row.args.includes('build')),false)
})

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
if(command.includes('/api/bots'))console.log('{"bots":[]}')
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
  assert.ok(commands.some(command=>command.includes('git merge -q --ff-only origin/main')&&command.includes(sha)))
  assert.ok(commands.some(command=>command.includes('queue-before-deploy-')))
  const launch=commands.filter(command=>command.includes('setsid nohup'))
  assert.equal(launch.length,1)
  if(selected){
    assert.ok(launch[0].includes(`BELLTEAM_SERVER_IMAGE=${image}`))
    assert.match(launch[0],/BELLTEAM_DEPLOY_QUIET_EXCEPT=bot-fixture sh scripts\/deploy-image\.sh/u)
    assert.doesNotMatch(launch[0],/compose build/u)
  }else assert.match(launch[0],/docker compose build --pull --no-cache/u)
})
