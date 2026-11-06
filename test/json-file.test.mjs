import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeAtomic } from '../src/json-file.mjs'

test('atomic JSON replaces the target and leaves only the completed file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-json-file-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'state.json')
  await writeFile(target, 'old')
  await writeAtomic(target, { value: 1 })
  assert.equal(await readFile(target, 'utf8'), '{\n  "value": 1\n}\n')
  assert.equal((await stat(target)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(root), ['state.json'])
})

test('rename rejection removes its temporary file and preserves the existing target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-json-file-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'state.json')
  await mkdir(target)
  await writeFile(join(target, 'keep'), 'existing state')
  await assert.rejects(writeAtomic(target, { value: 1 }), error => error.code === 'EISDIR' && error.syscall === 'rename')
  assert.deepEqual(await readdir(root), ['state.json'])
  assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'existing state')
})

test('write rejection keeps its original error when temporary cleanup also fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-json-file-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(writeAtomic(join(root, 'missing/state.json'), { value: 1 }),
    error => error.code === 'ENOENT' && error.syscall === 'open')
  assert.deepEqual(await readdir(root), [])
})
