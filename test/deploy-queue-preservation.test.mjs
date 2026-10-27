import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import test from 'node:test'

const exec = promisify(execFile)
const queue = '{"items":[{"botId":"bot-a"},{"target":"bot-b"},{"botId":"bot-a"}]}\n'
for (const scenario of ['fetch-failed', 'invalid-json', 'save-failed', 'ssh-failed', 'saved']) {
  test(`queue preservation before deploy: ${scenario}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'deploy-queue-'))
    t.after(() => rm(root, {recursive:true, force:true}))
    for (const path of ['scripts', 'bin', 'runtime/backups']) await mkdir(join(root, path), {recursive:true})
    await copyFile(new URL('../scripts/deploy.sh', import.meta.url), join(root, 'scripts/deploy.sh'))
    const backup = join(root, 'runtime/backups/queue-before-deploy-fixture.json')
    if (scenario === 'save-failed') await mkdir(backup)
    const programs = {
      git: '#!/bin/sh\nif [ "$1" = rev-parse ]; then printf "%040d\\n" 1; fi\n',
      date: '#!/bin/sh\nprintf fixture\n',
      sleep: '#!/bin/sh\nexit 0\n',
      docker: `#!/usr/bin/env node
process.stdout.write(process.env.FIXTURE_QUEUE)
if (process.env.FIXTURE_SCENARIO === 'fetch-failed') process.exitCode=7
`,
      ssh: `#!/usr/bin/env node
const fs=require('node:fs'), {spawnSync}=require('node:child_process'), command=process.argv[3]
fs.appendFileSync(process.env.FIXTURE_LOG, command+'\\n')
if(command.includes('/api/queue')){
  if(process.env.FIXTURE_SCENARIO === 'ssh-failed') process.exit(9)
  const result=spawnSync('/bin/sh',['-c',command.replaceAll('/home/kite/BellTeam',process.env.FIXTURE_ROOT)],{env:process.env,encoding:'utf8'})
  process.stdout.write(result.stdout);process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}
if(command.includes('/healthz')) console.log('{"status":"ok"}')
else if(command.includes('sh -s'))console.log('/home/kite/BellTeam/.bellteam-compose.ABC123/previous-normal.json')
else if(command.includes('/api/bots')) console.log('{"bots":[]}')
else if(command.includes('tail -3')) console.log('deploy-exit=0')
`,
    }
    for (const [name, program] of Object.entries(programs)) {
      await writeFile(join(root, 'bin', name), program)
      await chmod(join(root, 'bin', name), 0o755)
    }
    const env = {PATH:`${join(root, 'bin')}:${process.env.PATH}`,
      FIXTURE_ROOT:root, FIXTURE_LOG:join(root, 'calls'), FIXTURE_SCENARIO:scenario,
      FIXTURE_QUEUE:scenario === 'invalid-json' ? 'not-json' : queue,
      BELLTEAM_DEPLOY_IMAGE:`ghcr.io/fixture/server@sha256:${'a'.repeat(64)}`,
      BELLTEAM_DEPLOY_QUIET_EXCEPT:'bot-fixture'}
    const result = await exec('/bin/sh', ['scripts/deploy.sh'], {cwd:root, env}).catch(error => error)
    const calls = (await readFile(env.FIXTURE_LOG, 'utf8')).split('\n')
    assert.equal(calls.filter(c => c.includes('/api/queue')).length, 1)
    if (scenario === 'saved') {
      assert.equal(result.code, undefined)
      assert.match(result.stdout, /作業中のBot: bot-a bot-b/u)
      assert.equal(await readFile(backup, 'utf8'), queue)
      assert.equal(calls.filter(c => c.includes('setsid nohup')).length, 1)
    } else {
      assert.ok(result.code > 0)
      assert.equal(calls.some(c => c.includes('setsid nohup') || c.includes('/healthz') || c.includes('/api/bots')), false)
      assert.doesNotMatch(result.stdout, /作業中のBot: なし/u)
    }
  })
}
