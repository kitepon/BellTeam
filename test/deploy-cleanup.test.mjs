import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exec = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'deploy-cleanup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['scripts', 'bin', '.bellteam-compose.ABC123']) await mkdir(join(root, dir))
  await copyFile(new URL('../scripts/deploy-cleanup.sh', import.meta.url), join(root, 'scripts/deploy-cleanup.sh'))
  const saved = join(root, '.bellteam-compose.ABC123')
  await writeFile(join(saved, 'previous-normal.json'), JSON.stringify({ services: { bellteam: { image: 'sha256:' + 'b'.repeat(64) } } }))
  await writeFile(join(saved, 'previous-runtime.json'), JSON.stringify({ Image: 'sha256:' + 'b'.repeat(64) }))
  await writeFile(join(root, 'bin/python3'), `#!${process.execPath}
const fs=require('node:fs')
fs.writeFileSync(process.env.FIXTURE_ROOT+'/helper-args.json',JSON.stringify(process.argv.slice(2)))
console.log(JSON.stringify({phase:'plan',targets:['obsolete'],protected:['running','previous']}))
if(process.env.FIXTURE_EXIT==='17'){console.error('synthetic removal failure');process.exit(17)}
console.log(JSON.stringify({phase:'completed',removed:['obsolete']}))
`)
  await chmod(join(root, 'bin/python3'), 0o700)
  return { root, saved, run: (exit = '0', args = []) => exec('sh', ['scripts/deploy-cleanup.sh', join(saved, 'previous-normal.json'), ...args], {
    cwd: root, env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, FIXTURE_ROOT: root, FIXTURE_EXIT: exit },
  }) }
}

for (const exit of ['0', '17']) test(`normal cleanup preserves exact output and exit ${exit} under the existing deployment generation`, async t => {
  const f = await fixture(t)
  const result = await f.run(exit).catch(error => error)
  assert.equal(result.code ?? 0, Number(exit))
  const manifest = JSON.parse(await readFile(join(f.saved, 'deploy-cleanup.json'), 'utf8'))
  assert.equal(manifest.exit, Number(exit))
  assert.equal(manifest.previousRuntime, join(f.saved, 'previous-runtime.json'))
  assert.equal(manifest.stdout, join(f.saved, 'deploy-cleanup.stdout.jsonl'))
  assert.equal(manifest.stderr, join(f.saved, 'deploy-cleanup.stderr.log'))
  const rows = (await readFile(manifest.stdout, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].phase, 'plan')
  assert.deepEqual(rows[0].protected, ['running', 'previous'])
  assert.equal(rows.length, exit === '0' ? 2 : 1)
  assert.equal(await readFile(manifest.stderr, 'utf8'), exit === '0' ? '' : 'synthetic removal failure\n')
  assert.match(result.stdout, /deploy-cleanup-result=/)
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'helper-args.json'))), ['-B', 'scripts/cleanup-deploy-images.py', '--rollback-image', 'sha256:' + 'b'.repeat(64)])
  for (const file of ['deploy-cleanup.json', 'deploy-cleanup.stdout.jsonl', 'deploy-cleanup.stderr.log'])
    assert.equal((await stat(join(f.saved, file))).mode & 0o777, 0o600)
})

test('mismatched previous image is saved as failure before invoking cleanup', async t => {
  const f = await fixture(t)
  await writeFile(join(f.saved, 'previous-runtime.json'), JSON.stringify({ Image: 'sha256:' + 'c'.repeat(64) }))
  await assert.rejects(f.run(), error => error.code !== 0)
  await assert.rejects(readFile(join(f.root, 'helper-args.json')), { code: 'ENOENT' })
  const result = JSON.parse(await readFile(join(f.saved, 'deploy-cleanup.json')))
  assert.notEqual(result.exit, 0)
  assert.match(await readFile(result.stderr, 'utf8'), /BELLTEAM_CLEANUP_PREVIOUS_IMAGE_MISMATCH/)
})

for (const fail of [false, true]) test(`wrapper captures the runtime helper's actual plan and ${fail ? 'removal failure' : 'completion'}`, async t => {
  const f = await fixture(t)
  await rm(join(f.root, 'bin/python3'))
  await copyFile(new URL('../scripts/cleanup-deploy-images.py', import.meta.url), join(f.root, 'scripts/cleanup-deploy-images.py'))
  await writeFile(join(f.root, 'scripts/save-deploy-restore-point.py'), `import os
from pathlib import Path
BASE = Path(os.environ['FIXTURE_ROOT'])
def mount_guard(base): pass
def validated_points(base): raise AssertionError('normal caller must not read old NAS restore points')
`)
  await writeFile(join(f.root, '.lock'), '')
  await writeFile(join(f.root, 'bin/docker'), `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),r=process.env.FIXTURE_ROOT
const image=(c,tag)=>({Id:'sha256:'+c.repeat(64),RepoTags:['bellteam-server:'+tag],Created:'old'})
const rows=[image('a','current'),image('b','previous'),image('c','obsolete')]
if(a[0]==='ps')console.log('running')
else if(a[0]==='container')console.log(JSON.stringify([{Image:rows[0].Id}]))
else if(a[1]==='ls')console.log(rows.map(v=>v.Id).join('\\n'))
else if(a[1]==='inspect'){
 if(a.length===3&&a[2]===rows[2].Id&&fs.existsSync(r+'/removed')){
  console.error('Error response from daemon: No such image: '+rows[2].Id);process.exit(1)
 }
 console.log(JSON.stringify(rows.filter(v=>a.slice(2).includes(v.Id))))
}else if(a[1]==='rm'){
 if(${fail}){console.error('synthetic Docker removal failure');process.exit(17)}
 fs.writeFileSync(r+'/removed','yes');console.log('removed')
}else process.exit(91)
`)
  await chmod(join(f.root, 'bin/docker'), 0o700)
  const outcome = await f.run().catch(error => error)
  assert.equal(outcome.code ?? 0, fail ? 1 : 0)
  const result = JSON.parse(await readFile(join(f.saved, 'deploy-cleanup.json')))
  assert.equal(result.exit, fail ? 1 : 0)
  const rows = (await readFile(result.stdout, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].schema, 'bellteam.deploy-image-cleanup.plan.v1')
  assert.equal(rows[0].rollbackSource, 'caller-previous-runtime')
  assert.equal(rows[0].rollback, 'sha256:' + 'b'.repeat(64))
  assert.deepEqual(rows[0].targetImages, ['sha256:' + 'c'.repeat(64)])
  assert.deepEqual(rows[0].protectedImages, ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64)])
  if (fail) {
    assert.equal(rows.some(row => Array.isArray(row.removed)), false)
    assert.equal(rows[1].exit, 17)
    assert.match(rows[1].stderr, /synthetic Docker removal failure/)
    assert.match(await readFile(result.stderr, 'utf8'), /CalledProcessError/)
  } else assert.equal(rows.at(-1).removed[0].image, 'sha256:' + 'c'.repeat(64))
})


test('cleanup continuation preserves the old failure, saves a new private result once and never calls the installer', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run('17'), error => error.code === 17)
  const files = ['deploy-cleanup.stdout.jsonl', 'deploy-cleanup.stderr.log', 'deploy-cleanup.json']
  const original = await Promise.all(files.map(file => readFile(join(f.saved, file))))
  const continued = join(f.saved, 'deploy-cleanup-continuation')
  await f.run('0', ['--continue'])
  assert.equal((await stat(continued)).mode & 0o777, 0o700)
  const result = JSON.parse(await readFile(join(continued, 'deploy-cleanup.json')))
  assert.equal(result.exit, 0)
  assert.equal(result.previousRuntime, join(f.saved, 'previous-runtime.json'))
  assert.equal(result.stdout, join(continued, 'deploy-cleanup.stdout.jsonl'))
  for (const [n, file] of files.entries()) {
    assert.deepEqual(await readFile(join(f.saved, file)), original[n])
    assert.equal((await stat(join(continued, file))).mode & 0o777, 0o600)
  }
  const success = await readFile(join(continued, 'deploy-cleanup.json'))
  await assert.rejects(f.run('17', ['--continue']), error => error.code !== 0)
  assert.deepEqual(await readFile(join(continued, 'deploy-cleanup.json')), success)
  await assert.rejects(f.run('0', ['--unknown']), error => error.code === 2)
})
