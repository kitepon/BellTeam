import { copyInternalAdapter } from './fixtures/sec014-adapter.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
const exec = promisify(execFile), cid = 'c'.repeat(64), image = 'sha256:' + 'd'.repeat(64)
async function fixture(t, failure = '') {
  const root = await mkdtemp(join(tmpdir(), 'cursor-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['scripts', 'bin', 'volume/bin', 'volume/releases/old', 'volume/state']) await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, 'volume/releases/old/cursor-agent'), 'synthetic old CLI\n'); await chmod(join(root, 'volume/releases/old/cursor-agent'), 0o755)
  await symlink('../releases/old/cursor-agent', join(root, 'volume/bin/cursor-agent'))
  await writeFile(join(root, 'volume/state/keep.json'), '{"latest":"retained"}\n')
  await copyInternalAdapter(new URL('../scripts/deploy-image.sh', import.meta.url), join(root, 'scripts/deploy-image.sh'))
  await writeFile(join(root, 'scripts/check-deploy-quiet.sh'), '#!/bin/sh\ndocker fixture-quiet\n')
  const docker = `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(2),fail=process.env.FAIL
fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n')
if(a[0]==='container'&&a[1]==='inspect') {
 if(a.includes('{{.Id}} {{.Image}}'))console.log('${cid} ${image}')
 else {if(fail==='inspect'){process.stdout.write('partial metadata');process.exit(8)}console.log(fail==='mismatch'?'volume other-volume':'volume bellteam_cursor-cli')}
}
if(a[0]==='image'&&a[1]==='save')fs.writeFileSync(a[a.indexOf('--output')+1],'synthetic prior image')
if(a[0]==='exec'&&a.includes('/bin/tar')) {
 if(fail==='tar'){process.stdout.write('partial tar');process.exit(9)}
 const args=a.slice(a.indexOf('/bin/tar')+1).map(x=>x==='/home/bell/.local'?process.env.VOLUME:x)
 const result=cp.spawnSync('/bin/tar',args);process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status)
}
if(a[0]==='compose'&&a[1]==='pull')process.exit(97)
if(a[0]==='run')process.stdout.write(a.at(-1).endsWith('update-cursor.sh')?'#!/bin/sh\\ndocker fixture-cursor\\n':'services: {}\\n')
`
  const sha = '#!/bin/sh\nif [ "$FAIL" = hash ]; then case "$1" in */cursor.tar) exit 10;; esac; fi\nexec /usr/bin/sha256sum "$@"\n'
  for (const [name, body] of [['docker', docker], ['sha256sum', sha]]) { await writeFile(join(root, 'bin', name), body); await chmod(join(root, 'bin', name), 0o755) }
  const log = join(root, 'calls'); await writeFile(log, '')
  const result = await exec('sh', ['scripts/deploy-image.sh'], { cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, FAIL: failure, CALLS: log, VOLUME: join(root, 'volume'), TMPDIR: root, BELLTEAM_SERVER_IMAGE: 'fixture/server@sha256:' + 'a'.repeat(64), BELLTEAM_DEPLOY_QUIET_EXCEPT: 'bot-fixture' } }).catch(error => error)
  const calls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const [name] = await readdir(join(root, 'runtime/backups'))
  return { root, result, calls, saved: join(root, 'runtime/backups', name) }
}
test('same original CID archives complete Cursor files, symlink and mode before candidate pull', async t => {
  const f = await fixture(t)
  assert.equal(f.result.code, 97) // End this archive fixture at candidate acquisition.
  const bytes = await readFile(join(f.saved, 'cursor.tar'))
  assert.equal((await readFile(join(f.saved, 'cursor.tar.sha256'), 'utf8')).split(' ')[0], createHash('sha256').update(bytes).digest('hex'))
  assert.equal(await readFile(join(f.saved, 'cursor-volume.txt'), 'utf8'), 'volume bellteam_cursor-cli\n')
  assert.equal((await stat(join(f.saved, 'cursor.tar'))).mode & 0o777, 0o600)
  const restore = join(f.root, 'synthetic-extract'); await mkdir(restore)
  await exec('/bin/tar', ['-xf', join(f.saved, 'cursor.tar'), '-C', restore])
  assert.equal(await readFile(join(restore, 'releases/old/cursor-agent'), 'utf8'), 'synthetic old CLI\n')
  assert.equal((await stat(join(restore, 'releases/old/cursor-agent'))).mode & 0o777, 0o755)
  assert.equal(await readlink(join(restore, 'bin/cursor-agent')), '../releases/old/cursor-agent')
  assert.equal(await readFile(join(restore, 'state/keep.json'), 'utf8'), '{"latest":"retained"}\n')
  const tarIndex = f.calls.findIndex(a => a[0] === 'exec' && a.includes('/bin/tar'))
  const pullIndex = f.calls.findIndex(a => a[0] === 'compose' && a[1] === 'pull')
  assert.ok(tarIndex >= 0 && tarIndex < pullIndex)
  assert.deepEqual(f.calls[tarIndex].slice(0, 4), ['exec', '--user', 'bell', cid])
  assert.equal(f.calls.filter(a => a[0] === 'fixture-quiet').length, 0)
  assert.equal(f.calls.filter(a => a[0] === 'fixture-cursor').length, 0)
  assert.equal(f.calls.filter(a => a[0] === 'compose' && a[1] === 'up').length, 0)
})
for (const [failure, code] of [['mismatch', 1], ['inspect', 8], ['tar', 9], ['hash', 10]]) test(`Cursor ${failure} refusal retains originals and starts no candidate or update`, async t => {
  const f = await fixture(t, failure)
  assert.equal(f.result.code, code); assert.match(f.result.stdout, new RegExp('deploy-exit=' + code))
  assert.equal(f.calls.some(a => a[0] === 'compose' || a[0] === 'fixture-cursor' || a[0] === 'fixture-quiet'), false)
  assert.equal(await readFile(join(f.saved, 'container-image.txt'), 'utf8'), cid + ' ' + image + '\n')
  assert.equal(await readFile(join(f.saved, 'image.tar'), 'utf8'), 'synthetic prior image')
  if (failure === 'tar') assert.equal(await readFile(join(f.saved, 'cursor.tar'), 'utf8'), 'partial tar')
  if (failure === 'hash') assert.ok((await stat(join(f.saved, 'cursor.tar'))).size > 0)
})
