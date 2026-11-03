import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fsPromises, { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { createMembersProcess } from '../src/members-process.mjs'
import { MEMBERS_STATE_COMPATIBILITY } from '../src/members/state-compatibility.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createModuleExchangeMutex } from '../src/module-exchange-mutex.mjs'

const a = 'a'.repeat(64), bad = 'b'.repeat(64), hang = 'c'.repeat(64)
async function setup(t, { mode = '', prepare = async () => {}, membersAdmission, exchangeMutex } = {}) {
  const root = await mkdtemp(join(process.cwd(), '.members-controller-')), children = [], generations = []
  await mkdir(join(root, 'state/bots'), { recursive: true }); await mkdir(join(root, 'owner'))
  await writeFile(join(root, 'state/bots/.initialized'), '')
  await writeFile(join(root, 'owner/profile.json'), JSON.stringify({ schema: 'bellteam.owner-profile.v1', name: 'fixture', profile: '', avatar: '', xUrl: '', githubUrl: '', links: [] }))
  await writeFile(join(root, 'owner/user-rules.md'), '')
  const open = fsPromises.open, spawn = childProcess.spawn
  t.mock.method(fsPromises, 'open', async (path, ...args) => path === '/app/distribution.json'
    ? { stat: async () => ({ isFile: () => true, uid: 0, nlink: 1, mode: 0o644, size: 150 }),
      readFile: async () => JSON.stringify({ schema: 'bellteam.server.distribution.v1', sourceCommit: 'e'.repeat(40) }), close: async () => {} }
    : open(path, ...args))
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(command, '/usr/local/libexec/bellteam-members-start'); assert.equal(args.length, 1)
    assert.deepEqual(options, { env: {}, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    // Source fixture substitutes the fixed C executable, never adds a production path argument.
    const child = spawn(process.execPath, [new URL('./fixtures/members-runtime-child.mjs', import.meta.url).pathname,
      args[0], root, args[0] === bad ? 'bad-initialize' : args[0] === hang ? 'hang-initialize' : mode], options)
    children.push(child); return child
  })
  syncBuiltinESMExports()
  const controller = createMembersProcess({ root, membersAdmission, exchangeMutex, onGeneration: value => generations.push(value),
    prepareRelease: async (versionId, options) => { await prepare(versionId, options); return { versionId,
      appRoot: `/run/bellteam-maintenance/members/releases/${versionId}/payload`, protocolVersion: 1,
      stateCompatibility: MEMBERS_STATE_COMPATIBILITY, sourceCommit: 'e'.repeat(40), platform: { os: 'linux', arch: 'amd64' } } } })
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await ended
    }
    await controller.close().catch(() => {})
    t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true })
  })
  return { root, controller, children, generations }
}

test('shared exchange mutex rejects members before prepare and releases when close aborts preparation', async t => {
  const exchangeMutex = createModuleExchangeMutex()
  let entered, finish, preparations = 0
  const waiting = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { finish = resolve })
  const x = await setup(t, { exchangeMutex, prepare: async () => { preparations++; entered(); await held } })
  await x.controller.start()
  const release = exchangeMutex.reserve()
  await assert.rejects(x.controller.replace(a), { code: 'MODULE_EXCHANGE_BUSY', outcome: 'not_accepted' })
  assert.equal(preparations, 0); assert.equal(x.children.length, 1)
  assert.equal(x.controller.snapshot().available, true)
  release()
  const replacing = x.controller.replace(a), rejected = assert.rejects(replacing)
  await waiting
  await assert.rejects(exchangeMutex.runExclusive(() => {}), { code: 'MODULE_EXCHANGE_BUSY' })
  await x.controller.close(); await rejected
  await exchangeMutex.runExclusive(() => {})
  finish()
  assert.equal(x.children.length, 1)
})

test('controller routes a method pin through actual IPC while all AI lease slots are occupied', async t => {
  const gate = new MembersAdmission(), x = await setup(t, { membersAdmission: gate })
  await x.controller.start()
  const leases = Array.from({ length: 8 }, () => gate.enter()), pin = gate.enterReadPin('owner.read')
  await assert.rejects(x.controller.request('owner.read', {}), { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.equal((await x.controller.request('owner.read', {}, { membersReadPin: pin })).owner.name, 'fixture')
  gate.finishReadPin(pin); leases.forEach(lease => gate.finish(lease))
  await x.controller.close()
})

test('fixed builtin/archive/builtin controller preserves state and one writer after every OS close', async t => {
  const x = await setup(t); const before = await readFile(join(x.root, 'owner/profile.json'))
  await x.controller.start()
  await x.controller.replace(a)
  assert.equal(x.controller.snapshot().currentVersionId, a)
  await x.controller.replace('builtin')
  assert.equal(x.controller.snapshot().currentTarget, 'builtin')
  assert.deepEqual(await readFile(join(x.root, 'owner/profile.json')), before)
  assert.equal(x.children.filter(child => child.exitCode === null && child.signalCode === null).length, 1)
  assert.equal(new Set(x.generations).size, 3)
  assert.deepEqual(JSON.parse(await readFile(join(x.root, 'state/members-release.json'), 'utf8')),
    { schema: 'bellteam.members.adoption.v1', currentVersionId: null, previousVersionId: a })
  await x.controller.close(); assert.equal(x.controller.snapshot().phase, 'closed')
})

test('new restore failure and adoption failure return to old code on the same current state', async t => {
  const x = await setup(t); await x.controller.start()
  const before = await readFile(join(x.root, 'owner/user-rules.md'))
  await assert.rejects(x.controller.replace(bad), /MEMBERS_REPLACE_ROLLED_BACK/u)
  assert.equal(x.controller.snapshot().available, true)
  await mkdir(join(x.root, 'state/members-release.json'))
  await assert.rejects(x.controller.replace(a), /MEMBERS_REPLACE_ROLLED_BACK/u)
  assert.equal(x.controller.snapshot().currentVersionId, null)
  assert.deepEqual(await readFile(join(x.root, 'owner/user-rules.md')), before)
  assert.equal(x.children.filter(child => child.exitCode === null && child.signalCode === null).length, 1)
})

test('quiesce deadline resumes the same old child and never starts a second writer', async t => {
  const x = await setup(t, { mode: 'hang-quiesce' }); await x.controller.start()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const updating = x.controller.replace(a), rejected = assert.rejects(updating, { outcome: 'unknown' })
  while (x.controller.snapshot().phase !== 'quiescing') await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(60001)
  await rejected
  assert.equal(x.controller.snapshot().available, true); assert.equal(x.children.length, 1)
  await assert.rejects(x.controller.replace(a), { outcome: 'not_accepted' })
  t.mock.timers.reset()
})

test('catalog mismatch is rejected before admission closes, and close cannot launch after a delayed prepare', async t => {
  let hold = false, entered, release
  const waiting = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  const x = await setup(t, { prepare: async () => { if (hold) { entered(); await held } } })
  await x.controller.start()
  await assert.rejects(x.controller.replace(a, { expectedRelease: {} }), { code: 'MEMBERS_CATALOG_INCOMPATIBLE' })
  assert.equal(x.controller.snapshot().available, true)
  hold = true
  const updating = x.controller.replace(a), rejected = assert.rejects(updating)
  await waiting
  const closing = x.controller.close(); await rejected; await closing; release()
  assert.equal(x.children.length, 1)
})

test('unknown current state is rejected before the old writer exits', async t => {
  const x = await setup(t); await x.controller.start()
  const path = join(x.root, 'owner/profile.json'), original = await readFile(path)
  const invalid = JSON.stringify({ schema: 'unknown' }); await writeFile(path, invalid)
  await assert.rejects(x.controller.replace(a), { outcome: 'unknown' })
  assert.equal(x.children.length, 1); assert.equal(x.controller.snapshot().available, true)
  assert.equal(await readFile(path, 'utf8'), invalid)
  await writeFile(path, original)
})

test('45-second replacement ready failure is reaped before restoring the old code', async t => {
  const x = await setup(t); await x.controller.start()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const updating = x.controller.replace(hang), rejected = assert.rejects(updating, /MEMBERS_REPLACE_ROLLED_BACK/u)
  while (x.children.length < 2) await new Promise(resolve => setImmediate(resolve))
  const child = x.children[1]
  await new Promise(resolve => child.on('message', message => { if (message.type === 'accepted' && message.kind === 'control') resolve() }))
  t.mock.timers.tick(45001); await rejected
  assert.equal(x.children[1].exitCode !== null || x.children[1].signalCode !== null, true)
  assert.equal(x.controller.snapshot().currentVersionId, null)
  assert.equal(x.controller.snapshot().available, true)
  assert.equal(x.children.filter(value => value.exitCode === null && value.signalCode === null).length, 1)
  t.mock.timers.reset()
})

test('only a quiesced old child can be killed at the five-second exit deadline', async t => {
  const x = await setup(t, { mode: 'hang-exit' }); await x.controller.start()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const entered = new Promise(resolve => x.children[0].on('message', message => {
    if (message.type === 'accepted' && message.kind === 'control' && message.id === 4) resolve()
  }))
  const updating = x.controller.replace(a)
  await entered; t.mock.timers.tick(5001); await updating
  assert.equal(x.children[0].signalCode, 'SIGKILL')
  assert.equal(x.controller.snapshot().currentVersionId, a)
  assert.equal(x.children.filter(value => value.exitCode === null && value.signalCode === null).length, 1)
  t.mock.timers.reset()
})
