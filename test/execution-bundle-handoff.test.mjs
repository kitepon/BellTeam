import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { MembersAdmission } from '../src/members-admission.mjs'

const source = fileURLToPath(new URL('../src', import.meta.url))
const request = (method, ...args) => ({ method, args })
async function bundle(root, name, patches = []) {
  const path = join(root, name)
  await mkdir(path)
  await cp(source, join(path, 'src'), { recursive: true })
  await symlink(await realpath(new URL('../node_modules', import.meta.url)), join(path, 'node_modules'), 'dir')
  for (const [file, before, after] of patches) {
    const target = join(path, 'src', file), text = await readFile(target, 'utf8')
    assert.ok(text.includes(before), `synthetic fixture patch has a real target: ${file}`)
    await writeFile(target, text.replace(before, after))
  }
  return import(pathToFileURL(join(path, 'src/execution-dispatcher.mjs')).href)
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'execution-bundle-handoff-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bot = { id: 'bot-synthetic', name: 'Synthetic', session: 'synthetic-session', harness: 'codex' }
  const bots = new Map([[bot.id, bot]])
  let nativeCloses = 0
  const nativeCalls = []
  const ports = { bots, rooms: {}, membersAdmission: new MembersAdmission(),
    configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() },
    access: { assertWorkAllowed() {} }, observer: { report() {} },
    native: { async call(name) { nativeCalls.push(name); assert.equal(name, 'pty_list'); return {} },
      async close() { nativeCloses++ } },
  }
  const created = []
  t.after(async () => {
    for (const engine of created.reverse()) {
      try { await engine.control('quiesce', { timeoutMs: 50 }) } catch {}
      try { await engine.disconnect() } catch {}
    }
  })
  const create = (module, generation, handoff) => {
    const engine = module.createExecutionDispatcher({ generation, ports, handoff }); created.push(engine); return engine
  }
  const stop = async engine => { await engine.control('quiesce', { timeoutMs: 200 }); const state = engine.exportState(); await engine.disconnect(); return state }
  return { root, bot, ports, create, stop, nativeCalls, nativeCloses: () => nativeCloses }
}

test('different source bundles replace the actual administration engine and keep stop state through public handoff', async t => {
  const f = await fixture(t)
  const original = await bundle(f.root, 'original')
  const updated = await bundle(f.root, 'updated', [['bot-administration.mjs', 'return { ...bot,', "return { engineFixtureVersion: 'updated', ...bot,"]])
  const old = f.create(original, 'original')
  await old.control('initialize')
  const captured = old.project
  assert.equal(captured(request('administration.view', f.bot)).engineFixtureVersion, undefined)
  const state = await f.stop(old)
  state.metadata.sessions.set(f.bot.id, 'held-session')
  state.metadata.stopVersions.set(f.bot.id, 5)
  state.metadata.uncertainty.set(f.bot.id, 'agent_configure')
  state.metadata.uncertaintyVersions.set(f.bot.id, { request: { id: 'synthetic-original-request' } })
  const next = f.create(updated, 'updated', state)
  await next.control('initialize')
  // A relative business dependency, not just the entry wrapper, is now different.
  assert.equal(next.project(request('administration.view', f.bot)).engineFixtureVersion, 'updated')
  assert.equal(next.project(request('transport.session', f.bot)), 'held-session')
  assert.throws(() => captured(request('administration.view', f.bot)), { code: 'EXECUTION_NOT_ACCEPTING' })
  const after = await f.stop(next)
  assert.equal(after.metadata.stopVersions.get(f.bot.id), 5)
  // Since 02e7f51a uncertainty is not admission state: the legacy fields are exported empty and never imported.
  assert.equal(after.metadata.uncertainty.size, 0)
  assert.equal(after.metadata.uncertaintyVersions.size, 0)
  assert.equal(f.nativeCloses(), 0)
  assert.ok(f.nativeCalls.every(name => name === 'pty_list'))
})

test('failed candidate initialization is cleaned before reconstructing the previous real bundle with the same handoff', async t => {
  const f = await fixture(t)
  const original = await bundle(f.root, 'original')
  const bad = await bundle(f.root, 'bad', [['seat-turns.mjs', '  start() {', "  start() { throw new Error('SYNTHETIC_INITIALIZATION_FAILURE')"]])
  const old = f.create(original, 'original')
  await old.control('initialize')
  const state = await f.stop(old)
  const candidate = f.create(bad, 'failed-candidate', state)
  await assert.rejects(candidate.control('initialize'), /SYNTHETIC_INITIALIZATION_FAILURE/)
  assert.deepEqual(await candidate.disconnect(), { closed: true })
  assert.throws(() => candidate.project(request('transport.session', f.bot)), { code: 'EXECUTION_NOT_ACCEPTING' })
  const rollback = f.create(original, 'rollback', state)
  await rollback.control('initialize')
  assert.equal(rollback.project(request('transport.session', f.bot)), f.bot.session)
  assert.equal(rollback.project(request('administration.view', f.bot)).engineFixtureVersion, undefined)
  await f.stop(rollback)
  assert.equal(f.nativeCloses(), 0)
})
