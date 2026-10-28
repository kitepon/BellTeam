import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { migrateServerState } from '../src/server-state-transfer.mjs'

for (const failure of ['read', 'write', 'sync', 'complete-close']) test(`second view backup ${failure} failure preserves both source views and never relocates`, async t => {
  for (const direction of ['to-server', 'to-legacy']) {
    const parent = await mkdtemp(join(tmpdir(), 'backup-failure-propagation-'))
    t.after(() => rm(parent, { recursive: true, force: true }))
    const legacyRoot = join(parent, 'legacy'), serverRoot = join(parent, 'server'), backupRoot = join(parent, 'backup')
    for (const root of [legacyRoot, serverRoot, backupRoot]) await mkdir(root, { mode: 0o700 })
    const originals = [
      [join(legacyRoot, 'rooms/messages.jsonl'), 'legacy latest data\n'],
      [join(serverRoot, 'rooms/messages.jsonl'), 'server latest data\n'],
      [join(legacyRoot, 'bots/.initialized'), 'legacy marker'],
      [join(serverRoot, 'state/bots/.initialized'), 'server marker'],
    ]
    for (const [path, value] of originals) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value) }
    const second = join(backupRoot, 'server', 'before-' + direction)
    const target = join(second, 'rooms/messages.jsonl'), receipt = join(second, 'complete.json')
    const open = fs.promises.open
    const handles = [], error = Object.assign(new Error('synthetic backup I/O failure'), { code: 'EIO' })
    let injected = false
    fs.promises.open = async (...args) => {
      const file = await open(...args), close = file.close.bind(file)
      const row = { closed: false }; handles.push(row)
      file.close = async () => {
        await close(); row.closed = true
        if (failure === 'complete-close' && args[0] === receipt) { injected = true; throw error }
      }
      if (failure === 'read' && args[0] === originals[1][0]) file.read = async () => { injected = true; throw error }
      if (failure === 'write' && args[0] === target) {
        const write = file.write.bind(file)
        file.write = async buffer => { await write(buffer, 0, 1); injected = true; throw error }
      }
      if (failure === 'sync' && args[0] === target) file.sync = async () => { injected = true; throw error }
      return file
    }
    syncBuiltinESMExports()
    try { await assert.rejects(migrateServerState({ legacyRoot, serverRoot, backupRoot, direction }), { code: 'EIO' }) }
    finally { fs.promises.open = open; syncBuiltinESMExports() }
    assert.equal(injected, true)
    assert.equal(handles.every(row => row.closed), true)
    for (const [path, value] of originals) assert.equal(await readFile(path, 'utf8'), value)
    assert.equal(JSON.parse(await readFile(join(backupRoot, 'legacy', 'before-' + direction, 'complete.json'), 'utf8')).status, 'complete')
    await assert.rejects(lstat(receipt), { code: 'ENOENT' })
    const expected = failure === 'read' ? '' : failure === 'write' ? 's' : originals[1][1]
    assert.equal(await readFile(target, 'utf8'), expected)
    await assert.rejects(lstat(join(serverRoot, 'owner')), { code: 'ENOENT' })
    await assert.rejects(lstat(join(legacyRoot, 'state')), { code: 'ENOENT' })
  }
})
