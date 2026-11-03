import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MembersAdmission } from '../src/members-admission.mjs'
import { createMembersParentChannel, waitMembersChildClose } from '../src/members-ipc.mjs'
import { operateMembersProject } from '../src/members-project-files.mjs'
import { MEMBERS_STATE_COMPATIBILITY } from '../src/members/state-compatibility.mjs'
import { createMembersRuntimeEffects } from '../src/members-runtime-effects.mjs'

async function start(t, { onEffect: external, authorizeOwner } = {}) {
  const root = await mkdtemp(join(process.cwd(), '.members-ipc-'))
  const home = join(root, 'home')
  await mkdir(join(root, 'state/bots'), { recursive: true, mode: 0o700 })
  await writeFile(join(root, 'state/bots/.initialized'), '', { mode: 0o600 })
  await mkdir(join(root, 'owner'), { mode: 0o700 }); await mkdir(join(root, 'bots'))
  await writeFile(join(root, 'owner/profile.json'), JSON.stringify({ schema: 'bellteam.owner-profile.v1',
    name: 'fixture', profile: '', avatar: '', xUrl: '', githubUrl: '', links: [] }), { mode: 0o600 })
  await writeFile(join(root, 'owner/user-rules.md'), '', { mode: 0o600 })
  for (const cli of ['.claude', '.codex', '.grok', '.cursor', '.gemini']) await mkdir(join(home, cli), { recursive: true })
  const child = spawn(process.execPath, [new URL('./fixtures/members-runtime-child.mjs', import.meta.url).pathname, 'builtin', root],
    { env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const ended = waitMembersChildClose(child)
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes })
  const admission = new MembersAdmission('fixture'), projections = [], effects = []
  const channel = createMembersParentChannel(child, { generation: 'fixture', admission, authorizeOwner,
    onProjection: record => { projections.push(record) }, onEffect: async (method, params, context) => {
      effects.push(method)
      if (external) await external(method, params, context)
      if (method.startsWith('project.') || method === 'global.writeInstructions') return operateMembersProject({ root, home }, method, params)
      if (method === 'models.read') return { efforts: [], models: [] }
      if (['memory.ensureScope', 'cli.configure'].includes(method)) return null
      throw new Error('fixture effect missing')
    } })
  t.after(async () => { child.kill('SIGKILL'); await ended; channel.reaped(); await rm(root, { recursive: true, force: true }) })
  const initialized = await channel.control('initialize', { generation: 'fixture' }, 45000)
  assert.deepEqual(initialized, { stateCompatibility: MEMBERS_STATE_COMPATIBILITY })
  assert.deepEqual((await channel.ready).stateCompatibility, MEMBERS_STATE_COMPATIBILITY)
  const request = (method, params = {}, options = {}) => admission.withLease(lease =>
    channel.request(method, params, { ...options, membersLease: lease }))
  return { root, home, child, ended, channel, admission, effects, projections, request, stderr: () => stderr }
}

test('real IPC restores without effects, gates roots, sends generated text and closes after control-result', async t => {
  const x = await start(t)
  assert.deepEqual(x.effects, [])
  assert.deepEqual(x.projections.map(value => value.type), ['snapshot-start', 'snapshot-end'])
  await assert.rejects(x.request('profiles.read'), { outcome: 'not_accepted' })
  await x.channel.control('resume')
  const { bot } = await x.request('profile.create', { input: { name: 'fixture', harness: 'codex' } })
  assert.match(await readFile(join(x.root, 'bots', bot.id, 'AGENTS.md'), 'utf8'), /fixture/u)
  await x.channel.control('quiesce')
  await x.channel.control('exit')
  assert.deepEqual(await x.ended, { code: 0, signal: null })
  assert.equal(x.stderr(), '')
})

test('old lease callback and projection survive quiesce while a parent effect is pending', async t => {
  let block = false, entered, release
  const waiting = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  const x = await start(t, { onEffect: async method => {
    if (block && method === 'project.readPreviousSession') { entered(); await held }
  } })
  await x.channel.control('resume')
  const { bot } = await x.request('profile.create', { input: { name: 'fixture', harness: 'codex' } })
  block = true
  const lease = x.admission.enter()
  const changing = x.channel.request('profile.update', { botId: bot.id, changes: { name: 'changed' } }, { membersLease: lease })
  await waiting
  const ticket = x.admission.close()
  assert.throws(() => x.admission.enter(), { code: 'MEMBERS_NOT_ACCEPTED' })
  let stopped = false
  const quiescing = x.channel.control('quiesce', {}, 60000).then(value => { stopped = true; return value })
  const saved = await x.channel.callback('profile.session', { botId: bot.id, session: 'new-session' }, { membersLease: lease })
  assert.equal(saved.bot.session, 'new-session')
  assert.equal(stopped, false)
  release(); await changing
  x.admission.finish(lease); await x.admission.drain(ticket)
  assert.deepEqual(await quiescing, { quiesced: true })
  await x.channel.control('exit')
  assert.deepEqual(await x.ended, { code: 0, signal: null })
})

test('only the captured parent authorization becomes the child ownerWrite capability', async t => {
  const authorization = Object.freeze({}), allowed = new WeakSet([authorization])
  const x = await start(t, { authorizeOwner: (method, captured) => method === 'rules.update' && allowed.has(captured) })
  await x.channel.control('resume')
  await assert.rejects(x.request('rules.update', { text: 'changed' }, { capturedAuthorization: {} }), { outcome: 'not_accepted' })
  assert.deepEqual(await x.request('rules.update', { text: 'changed' }, { capturedAuthorization: authorization }), { text: 'changed\n' })
  assert.equal(await readFile(join(x.home, '.codex/AGENTS.md'), 'utf8').then(text => text.includes('changed')), true)
  await x.channel.control('quiesce'); await x.channel.control('exit'); await x.ended
})

test('eight roots and effects leave eight persistence callbacks available with a maximum four-image payload', { timeout: 20000 }, async t => {
  let block = false, entered, release, count = 0
  const waiting = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve })
  const x = await start(t, { onEffect: async method => {
    if (block && method === 'project.readPreviousSession') { if (++count === 8) entered(); await held }
  } })
  t.after(() => release())
  await x.channel.control('resume')
  const bots = []
  for (let i = 0; i < 8; i++) bots.push((await x.request('profile.create', { input: { name: `fixture-${i}`, harness: 'codex' } })).bot)
  const leases = bots.map(() => x.admission.enter())
  block = true
  const avatar = 'data:image/png;base64,' + 'a'.repeat(3_000_000 - 'data:image/png;base64,'.length)
  const mutations = bots.map((bot, i) => x.channel.request('profile.update', { botId: bot.id,
    changes: { name: `changed-${i}`, ...(i === 0 ? { avatar, avatarLarge: avatar, avatarSource: avatar, avatarLargeSource: avatar,
      avatarCrop: { x: 0, y: 0, width: 1, height: 1 }, avatarLargeCrop: { x: 0, y: 0, width: 1, height: 1 } } : {}) } },
  { membersLease: leases[i] }))
  await waiting
  assert.equal(x.channel.snapshot().root, 8)
  const ticket = x.admission.close()
  const callbacks = bots.map((bot, i) => x.channel.callback('profile.session', { botId: bot.id, session: `saved-${i}` }, { membersLease: leases[i] }))
  assert.equal(x.channel.snapshot().callback, 8)
  const saved = await Promise.all(callbacks)
  assert.deepEqual(saved.map(value => value.bot.session), bots.map((_bot, i) => `saved-${i}`))
  const quiescing = x.channel.control('quiesce', {}, 60000)
  release(); await Promise.all(mutations)
  for (const lease of leases) x.admission.finish(lease)
  await x.admission.drain(ticket); await quiescing
  assert.equal(x.channel.snapshot().queuedBytes, 0)
  await x.channel.control('exit'); assert.deepEqual(await x.ended, { code: 0, signal: null })
})

test('ACK and response deadlines report unknown while completion and old lease remain live', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const accepted of [false, true]) {
    const endpoint = new EventEmitter(); endpoint.connected = true
    let sent
    endpoint.send = (message, callback) => { sent = message; callback() }
    endpoint.disconnect = () => { endpoint.connected = false; endpoint.emit('disconnect') }
    const admission = new MembersAdmission('fixture')
    const channel = createMembersParentChannel(endpoint, { generation: 'fixture', admission })
    const lease = admission.enter()
    const attempt = channel.request('profiles.read', {}, { membersLease: lease })
    const rejected = assert.rejects(attempt, { outcome: 'unknown', code: accepted ? 'MEMBERS_IPC_TIMEOUT' : 'MEMBERS_IPC_ACK_TIMEOUT' })
    if (accepted) endpoint.emit('message', { type: 'accepted', kind: 'root', id: sent.id })
    t.mock.timers.tick(accepted ? 60001 : 5001); await rejected
    admission.finish(lease)
    assert.equal(admission.assertLease(lease), lease)
    assert.equal(channel.snapshot().root, 1)
    if (!accepted) endpoint.emit('message', { type: 'accepted', kind: 'root', id: sent.id })
    endpoint.emit('message', { type: 'result', kind: 'root', id: sent.id, ok: true, value: { profiles: [] } })
    await attempt.completion
    await Promise.resolve()
    assert.throws(() => admission.assertLease(lease), { code: 'MEMBERS_NOT_ACCEPTED' })
    assert.equal(channel.snapshot().root, 0)
    channel.reaped()
  }
})

test('CLI configuration reads the current child IDs through its reserved callback while the root waits', async t => {
  let x, seen
  const runtimeEffect = createMembersRuntimeEffects({
    seatRuntime: { configureMembersHarnesses: async read => { seen = await read() } }, aiterm: {}, callBridge: () => ({ enabled: false }),
    readCurrentBotIds: async context => (await x.channel.callback('profiles.cli', {}, context)).botIds,
  })
  x = await start(t, { onEffect: async (method, params, context) => {
    if (method === 'cli.configure') await runtimeEffect(method, params, context)
  } })
  await x.channel.control('resume')
  const created = await x.request('profile.create', { input: { name: 'fixture', harness: 'codex' } })
  assert.deepEqual(seen, [created.bot.id])
  await x.channel.control('quiesce'); await x.channel.control('exit'); await x.ended
})

test('trusted old lease fresh read and startup continue through the closed child root gate', async t => {
  const x = await start(t); await x.channel.control('resume')
  const { bot } = await x.request('profile.create', { input: { name: 'fixture', harness: 'codex' } })
  const lease = x.admission.enter(), ticket = x.admission.close()
  await x.channel.control('quiesce')
  const fresh = await x.channel.request('profile.read', { botId: bot.id }, { membersLease: lease })
  assert.equal(fresh.bot.id, bot.id)
  await x.channel.request('profile.startup', { botId: bot.id, shortTermMemory: 'continued' }, { membersLease: lease })
  const saved = await x.channel.callback('profile.session', { botId: bot.id, session: 'continued-session' }, { membersLease: lease })
  assert.equal(saved.bot.session, 'continued-session')
  assert.equal(await readFile(join(x.root, 'bots', bot.id, 'memory/previous-session.md'), 'utf8'), 'continued\n')
  assert.throws(() => x.request('profiles.read', { continuation: true }), { outcome: 'not_accepted' })
  assert.throws(() => x.admission.enter(), { code: 'MEMBERS_NOT_ACCEPTED' })
  x.admission.finish(lease); await x.admission.drain(ticket)
  await x.channel.control('quiesce'); await x.channel.control('exit'); await x.ended
})

test('parent IPC loss drains the child but does not erase a still-running parent effect lease', async t => {
  let block = false, entered, release
  const waiting = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
  const x = await start(t, { onEffect: async method => {
    if (block && method === 'project.readPreviousSession') { entered(); await held }
  } })
  t.after(() => release())
  await x.channel.control('resume')
  const { bot } = await x.request('profile.create', { input: { name: 'fixture', harness: 'codex' } })
  block = true
  const lease = x.admission.enter()
  const attempt = x.channel.request('profile.update', { botId: bot.id, changes: { name: 'saved-before-loss' } }, { membersLease: lease })
  const rejected = assert.rejects(attempt, { outcome: 'unknown' })
  await waiting; x.child.disconnect(); await rejected
  await x.ended; x.channel.reaped(); x.admission.finish(lease)
  assert.equal(x.admission.assertLease(lease), lease)
  const parentFinished = x.admission.drain(x.admission.close())
  release(); await parentFinished
  assert.equal(JSON.parse(await readFile(join(x.root, 'state/bots', bot.id, 'bot.json'), 'utf8')).name, 'saved-before-loss')
})
