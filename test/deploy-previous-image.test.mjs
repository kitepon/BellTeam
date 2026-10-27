import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
const exec = promisify(execFile)
const cid = 'c'.repeat(64), previous = 'sha256:' + 'd'.repeat(64)
async function fixture(t, failure = '') {
  const root = await mkdtemp(join(tmpdir(), 'deploy-image-preserve-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['scripts', 'bin']) await mkdir(join(root, name))
  await copyFile(new URL('../scripts/deploy-image.sh', import.meta.url), join(root, 'scripts/deploy-image.sh'))
  await writeFile(join(root, 'scripts/check-deploy-quiet.sh'), '#!/bin/sh\ndocker fixture-quiet\n')
  const docker = `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2),fail=process.env.FAIL
fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n')
if(a[0]==='container'&&a[1]==='inspect') {if(fail==='inspect'){process.stdout.write('partial');process.exit(6)}console.log('${cid} ${previous}')}
if(a[0]==='image'&&a[1]==='save'){fs.writeFileSync(a[a.indexOf('--output')+1],fail==='save'?'partial-image':'synthetic-image-bytes');if(fail==='save')process.exit(7)}
if(a[0]==='run')process.stdout.write(a.at(-1).endsWith('update-cursor.sh')?'#!/bin/sh\\ndocker fixture-cursor\\n':'services: {}\\n')
`
  for (const [name, body] of [['docker', docker], ['sha256sum', '#!/bin/sh\n[ "$FAIL" != hash ] || exit 8\nexec /usr/bin/sha256sum "$@"\n']]) {
    await writeFile(join(root, 'bin', name), body); await chmod(join(root, 'bin', name), 0o755)
  }
  const calls = join(root, 'calls'); await writeFile(calls, '')
  const result = await exec('sh', ['scripts/deploy-image.sh'], { cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, CALLS: calls, FAIL: failure, TMPDIR: root, BELLTEAM_SERVER_IMAGE: 'fixture/server@sha256:' + 'a'.repeat(64), BELLTEAM_DEPLOY_QUIET_EXCEPT: 'bot-fixture' } }).catch(error => error)
  return { root, result, calls: (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) }
}
test('prior image ID archive and digest persist before candidate pull and update', async t => {
  const f = await fixture(t)
  assert.equal(f.result.code, undefined)
  const dirs = await readdir(join(f.root, 'runtime/backups')); assert.equal(dirs.length, 1)
  const saved = join(f.root, 'runtime/backups', dirs[0])
  assert.equal((await stat(saved)).mode & 0o777, 0o700)
  assert.equal(await readFile(join(saved, 'container-image.txt'), 'utf8'), cid + ' ' + previous + '\n')
  const image = await readFile(join(saved, 'image.tar'))
  assert.equal(image.toString(), 'synthetic-image-bytes')
  assert.equal((await stat(join(saved, 'image.tar'))).mode & 0o777, 0o600)
  assert.equal((await readFile(join(saved, 'image.tar.sha256'), 'utf8')).split(' ')[0], createHash('sha256').update(image).digest('hex'))
  assert.deepEqual(f.calls.slice(0, 2).map(a => a.slice(0, 2)), [['container', 'inspect'], ['image', 'save']])
  assert.equal(f.calls[1].at(-1), previous)
  assert.equal(f.calls.filter(a => a[0] === 'fixture-cursor').length, 1)
  assert.equal(f.calls.filter(a => a[0] === 'fixture-quiet').length, 2)
  assert.equal(f.calls.filter(a => a[0] === 'compose' && a[1] === 'up').length, 1)
  assert.equal(f.calls.some(a => a.includes('stop') || a.includes('rm') && a[0] === 'image' || a.includes('load')), false)
})
for (const [failure, code] of [['inspect', 6], ['save', 7], ['hash', 8]]) test(`${failure} failure retains partial originals without candidate pull or updater`, async t => {
  const f = await fixture(t, failure)
  assert.equal(f.result.code, code)
  assert.match(f.result.stdout, new RegExp('deploy-exit=' + code))
  assert.equal(f.calls.some(a => a[0] === 'compose' || a[0] === 'fixture-cursor'), false)
  const dirs = await readdir(join(f.root, 'runtime/backups')); assert.equal(dirs.length, 1)
  const saved = join(f.root, 'runtime/backups', dirs[0])
  assert.equal(await readFile(join(saved, 'container-image.txt'), 'utf8'), failure === 'inspect' ? 'partial' : cid + ' ' + previous + '\n')
  if (failure !== 'inspect') assert.equal(await readFile(join(saved, 'image.tar'), 'utf8'), failure === 'save' ? 'partial-image' : 'synthetic-image-bytes')
})
