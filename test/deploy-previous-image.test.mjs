import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
const exec = promisify(execFile)
const realSha256sum = (await exec('sh', ['-c', 'command -v sha256sum'])).stdout.trim()
const realTee = (await exec('sh', ['-c', 'command -v tee'])).stdout.trim()
const cid = 'c'.repeat(64), previous = 'sha256:' + 'd'.repeat(64)
async function fixture(t, failure = '') {
  const root = await mkdtemp(join(tmpdir(), 'deploy-image-preserve-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['scripts', 'bin']) await mkdir(join(root, name))
  for (const name of ['deploy-image.sh', 'archive-live-volume.py'])
    await copyFile(new URL('../scripts/' + name, import.meta.url), join(root, 'scripts', name))
  await writeFile(join(root, 'scripts/check-deploy-quiet.sh'), '#!/bin/sh\ndocker fixture-quiet\n')
  const docker = `#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2),fail=process.env.FAIL
fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n')
if(a[0]==='container'&&a[1]==='inspect') {if(fail==='inspect'){process.stdout.write('partial');process.exit(6)}console.log(a.includes('{{.Id}} {{.Image}}')?'${cid} ${previous}':'volume bellteam_cursor-cli')}
if(a[0]==='image'&&a[1]==='save'){const bytes=fail==='save'?'partial-image':'synthetic-image-bytes';if(a.includes('--output'))fs.writeFileSync(a[a.indexOf('--output')+1],bytes);else process.stdout.write(bytes);if(fail==='save')process.exit(7)}
if(a[0]==='run')process.stdout.write(a.at(-1).endsWith('update-cursor.sh')?'#!/bin/sh\\ndocker fixture-cursor\\n':'services: {}\\n')
`
  for (const [name, body] of [['tee', '#!/bin/sh\n"$REAL_TEE" "$@" || exit $?\n[ "$FAIL" != write ] || exit 9\n'], ['docker', docker], ['sha256sum', '#!/bin/sh\nif [ "$FAIL" = hash ]; then [ "$#" -gt 0 ] || cat > /dev/null; exit 8; fi\n[ "$FAIL" != reread ] || [ "$#" -eq 0 ] || exit 11\nexec "$REAL_SHA256SUM" "$@"\n']]) {
    await writeFile(join(root, 'bin', name), body); await chmod(join(root, 'bin', name), 0o755)
  }
  const calls = join(root, 'calls'); await writeFile(calls, '')
  const result = await exec('sh', ['scripts/deploy-image.sh'], { cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, REAL_SHA256SUM: realSha256sum, REAL_TEE: realTee, CALLS: calls, FAIL: failure, TMPDIR: root, BELLTEAM_SERVER_IMAGE: 'fixture/server@sha256:' + 'a'.repeat(64), BELLTEAM_DEPLOY_QUIET_EXCEPT: 'bot-fixture' } }).catch(error => error)
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
test('backup hashes consume the producer streams and keep standard checksum files', async t => {
  const f = await fixture(t, 'reread')
  assert.equal(f.result.code, undefined, f.result.stderr)
  const [name] = await readdir(join(f.root, 'runtime/backups'))
  const saved = join(f.root, 'runtime/backups', name)
  await exec(realSha256sum, ['-c', join(saved, 'image.tar.sha256')], { cwd: f.root })
  await exec(realSha256sum, ['-c', join(saved, 'cursor.tar.sha256')], { cwd: f.root })
})
for (const [failure, code] of [['inspect', 6], ['save', 7], ['hash', 8], ['write', 9]]) test(`${failure} failure retains partial originals without candidate pull or updater`, async t => {
  const f = await fixture(t, failure)
  assert.equal(f.result.code, code)
  assert.match(f.result.stdout, new RegExp('deploy-exit=' + code))
  assert.equal(f.calls.some(a => a[0] === 'compose' || a[0] === 'fixture-cursor'), false)
  const dirs = await readdir(join(f.root, 'runtime/backups')); assert.equal(dirs.length, 1)
  const saved = join(f.root, 'runtime/backups', dirs[0])
  assert.equal(await readFile(join(saved, 'container-image.txt'), 'utf8'), failure === 'inspect' ? 'partial' : cid + ' ' + previous + '\n')
  assert.equal((await readdir(saved)).includes('image.tar.sha256'), false)
  if (failure !== 'inspect') assert.equal(await readFile(join(saved, 'image.tar'), 'utf8'), failure === 'save' ? 'partial-image' : 'synthetic-image-bytes')
})
