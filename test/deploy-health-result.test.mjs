import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import test from 'node:test'

const exec = promisify(execFile)

for (const [name, body, sshExit, success] of [
  ['healthy', '{"status":"ok"}', 0, true],
  ['unhealthy', '{"status":"unhealthy","ok":true}', 0, false],
  ['invalid-json', 'not-json', 0, false],
  ['ssh-failed', '', 7, false],
]) test(`deploy health result: ${name}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deploy-health-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  await mkdir(join(root, 'scripts'))
  await mkdir(join(root, 'bin'))
  await copyFile(new URL('../scripts/deploy.sh', import.meta.url), join(root, 'scripts/deploy.sh'))
  const programs = {
    git: '#!/bin/sh\nif [ "$1" = rev-parse ]; then printf "%040d\\n" 1; fi\n',
    sleep: '#!/bin/sh\nexit 0\n',
    ssh: `#!/usr/bin/env node
const fs=require('node:fs'), command=process.argv[3]
fs.appendFileSync(process.env.FIXTURE_LOG, command+'\\n')
if(command.includes('/healthz')){
  process.stdout.write(process.env.FIXTURE_HEALTH)
  process.exit(Number(process.env.FIXTURE_HEALTH_EXIT))
}
if(command.includes('/api/bots')) console.log('{"bots":[]}')
else if(command.includes('tail -3')) console.log('deploy-exit=0')
`,
  }
  for (const [name, program] of Object.entries(programs)) {
    await writeFile(join(root, 'bin', name), program)
    await chmod(join(root, 'bin', name), 0o755)
  }
  const env = {PATH:`${join(root,'bin')}:${process.env.PATH}`,
    FIXTURE_LOG:join(root,'calls'), FIXTURE_HEALTH:body, FIXTURE_HEALTH_EXIT:String(sshExit),
    BELLTEAM_DEPLOY_IMAGE:`ghcr.io/fixture/server@sha256:${'a'.repeat(64)}`,
    BELLTEAM_DEPLOY_QUIET_EXCEPT:'bot-fixture'}
  const result = await exec('/bin/sh', ['scripts/deploy.sh'], {cwd:root, env}).catch(error => error)
  const calls = (await readFile(env.FIXTURE_LOG,'utf8')).split('\n')
  assert.equal(calls.filter(command=>command.includes('setsid nohup')).length, 1)
  if (success) {
    assert.equal(result.code, undefined)
    assert.match(result.stdout, /bots 0 online 0/u)
    assert.ok(calls.filter(command=>command.includes('/healthz')).length > 0)
  } else {
    assert.equal(result.code, 1)
    assert.match(result.stderr, /healthz/u)
    assert.equal(calls.filter(command=>command.includes('/healthz')).length, 24)
    assert.equal(calls.some(command=>command.includes('node --version')||command.includes('/api/bots')), false)
  }
})
