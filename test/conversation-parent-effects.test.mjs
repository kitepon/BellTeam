import assert from 'node:assert/strict'
import test from 'node:test'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import { createConversationParentEffects } from '../src/conversation-parent-effects.mjs'
import { createConversationObserverParentEffects } from '../src/conversation/observer-parent.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const context = () => ({ generation: 'generation-a', operationId: 'operation-a', actor: { kind: 'observer' },
  continuation: false, rootMethod: 'observation.poll', operationContext: {}, actualCompletion: Promise.withResolvers().promise })

test('parent adapter reads fresh display fields and delegates only closed usage/observer/execution with original context', async () => {
  const ctx = context(), calls = [], refreshed = Promise.withResolvers()
  const bot = { id: 'bot-a', name: 'A', displayName: 'Display', position: 'Role', role: 'Scope', project: '/parent/project', apiKey: 'private' }
  let fresh = false
  const services = { bots: { refresh: async value => { assert.equal(value, ctx.operationContext); await refreshed.promise; fresh = true },
    values: () => { assert(fresh); return [bot] } },
  conversationUsage: { dispatch: async (...args) => { calls.push(args); return { enabled: false, epoch: 3, apiKey: null } } } }
  const observer = createConversationObserverParentEffects({ snapshot: value => { assert.equal(value, ctx); return [bot] },
    current: (id, value) => { assert.equal(id, bot.id); assert.equal(value, ctx); return bot },
    check: () => { throw new Error('unexpected check') }, read: () => { throw new Error('unexpected read') } })
  const adapter = createConversationParentEffects({ getServices: () => services, observerEffects: observer,
    onExecution: async (...args) => { calls.push(args); return args[0] === 'execution.notify' ? { delivery: 'running' } : { allowed: true } } })
  const profiles = adapter('members.profiles.read', {}, ctx)
  await tick(); assert.equal(fresh, false); refreshed.resolve()
  assert.deepEqual(await profiles, { bots: [{ id: 'bot-a', name: 'A', displayName: 'Display', position: 'Role', role: 'Scope' }] })
  assert.deepEqual(await adapter('usage.routing.read', {}, ctx), { enabled: false, epoch: 3, apiKey: null })
  const snapshot = await adapter('runtime.observer.snapshot', {}, ctx)
  assert.equal(snapshot.projects[0].botId, bot.id); assert.equal(JSON.stringify(snapshot).includes(bot.project), false)
  assert.deepEqual(await adapter('execution.assertAccess', {}, ctx), { allowed: true })
  ctx.conversationDelivery = Object.freeze({ opaque: true })
  const queue = { context: 'direct', contextId: 'bot-a', groupId: 'delivery-a', from: 'user', fromName: 'Owner', target: 'bot-a', message: 'Q' }
  assert.deepEqual(await adapter('execution.notify', { deliveryId: 'delivery-a', target: 'bot-a', message: 'Q', images: [], queue,
    kinds: ['delivery.status', 'delivery.answer'] }, ctx), { delivery: 'running' })
  for (const [, , value] of calls) assert.equal(value, ctx)
  await assert.rejects(adapter('runtime.observer.read', { botId: bot.id, scope: snapshot.projects[0].scope }, { ...ctx }),
    { code: 'CONVERSATION_OBSERVER_SOURCE_CHANGED' })
})

test('room context uses the existing runner with only the fixed parent rooms root', async t => {
  const ctx = context(), params = { roomId: 'room-a', messageId: 'message-a', speaker: 'A', text: 'Q' }
  let captured
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(command, 'throughline'); assert.deepEqual(args, ['room-context', '--json'])
    assert.deepEqual(options, { stdio: ['pipe', 'pipe', 'pipe'] })
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.stdin = new Writable({ write(chunk, _encoding, done) { captured = JSON.parse(chunk); done() },
      final(done) { child.stdout.end(JSON.stringify({ schema: 'throughline.room_context.v1', status: 'ready',
        turns: [{ messageId: params.messageId, speaker: params.speaker, text: params.text }] })); done(); setImmediate(() => child.emit('close', 0)) } })
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const adapter = createConversationParentEffects({ getServices: () => ({ roomsRoot: '/parent/fixed/rooms' }) })
  assert.deepEqual(await adapter('runtime.room.context', params, ctx), { turns: [{ speaker: 'A', text: 'Q' }] })
  assert.deepEqual(captured, { projectPath: '/parent/fixed/rooms', ...params })
})

test('save handles retain their original parent gate/runtime and track real root/read completion before read', async () => {
  const ctx = context(), actual = Promise.withResolvers(), read = Promise.withResolvers(), gateDone = Promise.withResolvers()
  ctx.actualCompletion = actual.promise
  const lease = {}, tracked = [], readCalls = []
  let endCalls = 0, began = false
  const gate = { beginSave: async (owner, value) => { assert.equal(owner, 'bot-a'); assert.equal(value, ctx.operationContext); began = true; return lease },
    trackCompletion: (value, task) => { assert.equal(value, lease); tracked.push(task) },
    assertSave: (value, owner, parent) => { assert.equal(value, lease); assert.equal(owner, 'bot-a'); assert.equal(parent, ctx.operationContext) },
    endSave: value => { assert.equal(value, lease); endCalls++; return gateDone.promise } }
  let services = { conversationAssetGate: gate, conversationCompletion: value => { assert.equal(value, ctx); return actual.promise },
    seatRuntime: { readImage: (image, maxBytes) => { assert.equal(tracked.length, 2); readCalls.push({ image, maxBytes }); return read.promise } } }
  const adapter = createConversationParentEffects({ getServices: () => services })
  const handle = await adapter('assets.beginSave', { owner: 'bot-a' }, ctx)
  assert(began); assert.deepEqual(tracked, [actual.promise])
  services = { conversationAssetGate: {}, seatRuntime: { readImage: () => { throw new Error('wrong generation runtime') } } }
  for (const other of [{ ...ctx }, { ...ctx, generation: 'generation-b' }, { ...ctx, operationId: 'operation-b' }])
    await assert.rejects(adapter('runtime.image.read', { leaseId: handle.leaseId, image: { path: '/captured/image' } }, other), { code: 'IMAGE_SAVE_LEASE_INVALID' })
  const reading = adapter('runtime.image.read', { leaseId: handle.leaseId, image: { path: '/captured/image' } }, ctx)
  await tick(); assert.deepEqual(readCalls, [{ image: { path: '/captured/image' }, maxBytes: 25 * 1024 * 1024 }])
  assert.deepEqual(await adapter('assets.endSave', handle, ctx), { requested: true })
  assert.equal(endCalls, 1)
  await assert.rejects(adapter('runtime.image.read', { ...handle, image: { path: '/captured/image' } }, ctx), { code: 'IMAGE_SAVE_LEASE_INVALID' })
  read.resolve(Buffer.from('image')); assert.deepEqual(await reading, { data: Buffer.from('image').toString('base64') })
  actual.reject(new Error('child reaped')); await tick(); assert.equal(endCalls, 1)
  gateDone.resolve(); await tick()
  await assert.rejects(adapter('assets.endSave', handle, ctx), { code: 'IMAGE_SAVE_LEASE_INVALID' })
})

test('assets.read reads a saved image through the parent reader inside the save lease, tracked before the read', async () => {
  const ctx = context(), actual = Promise.withResolvers(), lease = {}, tracked = [], opened = []
  ctx.actualCompletion = actual.promise
  const gate = { beginSave: async () => lease, trackCompletion: (value, task) => { assert.equal(value, lease); tracked.push(task) },
    assertSave: () => {}, endSave: async () => {} }
  const services = { conversationAssetGate: gate, conversationCompletion: () => actual.promise,
    conversationAssetOpen: async (owner, file) => { assert.equal(tracked.length, 2); opened.push([owner, file]); return { stream: Readable.from([Buffer.from('im'), Buffer.from('age')]) } } }
  const adapter = createConversationParentEffects({ getServices: () => services })
  const handle = await adapter('assets.beginSave', { owner: 'bot-b' }, ctx)
  const params = { owner: 'bot-a', file: 'message-a-1.png', ...handle }
  await assert.rejects(adapter('assets.read', params, { ...ctx }), { code: 'IMAGE_SAVE_LEASE_INVALID' })
  assert.deepEqual(await adapter('assets.read', params, ctx), { data: Buffer.from('image').toString('base64') })
  assert.deepEqual(opened, [['bot-a', 'message-a-1.png']])
  await assert.rejects(adapter('assets.read', { ...params, file: '../x.png' }, ctx), { code: 'CONVERSATION_EFFECT_INVALID' })
  await adapter('assets.endSave', handle, ctx)
  await assert.rejects(adapter('assets.read', params, ctx), { code: 'IMAGE_SAVE_LEASE_INVALID' })
  const none = createConversationParentEffects({ getServices: () => ({ ...services, conversationAssetOpen: undefined }) })
  const h2 = await none('assets.beginSave', { owner: 'bot-b' }, ctx)
  await assert.rejects(none('assets.read', { ...params, ...h2 }, ctx), { code: 'CONVERSATION_EFFECT_UNAVAILABLE' })
  actual.resolve()
})

test('missing completion and invalid DTOs refuse before effects; upstream failures retain their identity', async () => {
  let effects = 0
  const ctx = context(), failure = Object.assign(new Error('upstream'), { code: 'AI_GLOBAL_PAUSED' })
  const adapter = createConversationParentEffects({ getServices: () => ({ conversationAssetGate: { beginSave: () => { effects++ } } }),
    onExecution: () => { effects++; throw failure } })
  await assert.rejects(adapter('assets.beginSave', { owner: 'bot-a' }, ctx), { code: 'CONVERSATION_EFFECT_UNAVAILABLE' })
  await assert.rejects(adapter('arbitrary.rpc', {}, ctx), { code: 'CONVERSATION_EFFECT_INVALID' })
  await assert.rejects(adapter('runtime.room.context', { roomId: 'room-a', messageId: 'message-a', speaker: 'A', text: 'Q', projectPath: '/caller' }, ctx))
  assert.equal(effects, 0)
  await assert.rejects(adapter('execution.assertAccess', {}, ctx), error => error === failure)
  assert.equal(effects, 1)
  const bad = createConversationParentEffects({ getServices: () => ({}), onExecution: () => ({ allowed: true, extra: 'private' }) })
  await assert.rejects(bad('execution.assertAccess', {}, ctx), { code: 'CONVERSATION_EFFECT_INVALID' })
})

test('a fork callback reads profiles with the members read pin, not the root lease the root result already returned', async () => {
  const stale = { generation: 1, id: 'root-lease' }
  const ctx = { generation: 'generation-a', operationId: 'operation-a', deliveryId: 'delivery-a', target: 'bot-a', callbackKind: 'delivery.answer',
    rootMethod: 'fork.ask', operationContext: { membersLease: stale, capturedAuthorization: 'auth' } }
  let seen
  const services = { bots: { refresh: async value => { seen = value }, values: () => [{ id: 'bot-a', name: 'A' }] } }
  const adapter = createConversationParentEffects({ getServices: () => services })
  assert.deepEqual(await adapter('members.profiles.read', {}, ctx), { bots: [{ id: 'bot-a', name: 'A' }] })
  assert.deepEqual(seen, { capturedAuthorization: 'auth' })
  assert.equal(ctx.operationContext.membersLease, stale)
})

// a521: the image path of a remote seat is on its own terminal; the body does not open it and says so, instead of IMAGE_FILE_NOT_FOUND.
test('a remote seat image path is not read on the body; a local seat and a data image are', async () => {
  const ctx = context(), actual = Promise.withResolvers(), reads = []
  ctx.actualCompletion = actual.promise
  const gate = { beginSave: async () => ({}), trackCompletion: () => {}, assertSave: () => {}, endSave: async () => {} }
  const bots = new Map([['bot-remote', { id: 'bot-remote', terminalId: 'mac', projectRoot: '/Users/x/p' }], ['bot-local', { id: 'bot-local' }]])
  const services = { conversationAssetGate: gate, conversationCompletion: () => actual.promise, bots,
    seatRuntime: { readImage: async image => { reads.push(image); return Buffer.from('image') } } }
  const adapter = createConversationParentEffects({ getServices: () => services })
  const read = async (owner, image) => adapter('runtime.image.read', { leaseId: (await adapter('assets.beginSave', { owner }, ctx)).leaseId, image }, ctx)
  await assert.rejects(read('bot-remote', { path: '/tmp/x.png' }), { message: 'IMAGE_REMOTE_READ_UNAVAILABLE' })
  await assert.rejects(read('bot-remote', { path: 'C:\\x.png' }), { message: 'IMAGE_REMOTE_READ_UNAVAILABLE' })
  assert.deepEqual(reads, [])
  assert.equal((await read('bot-local', { path: '/tmp/x.png' })).data, Buffer.from('image').toString('base64'))
  assert.equal((await read('bot-remote', { mime: 'image/png', data: 'iVBORw0KGgo=' })).data, Buffer.from('image').toString('base64'))
  assert.deepEqual(reads.length, 2)
})

// a521c: with Aiterm's terminal read on the transport, a remote seat's path image comes from the terminal; its refusal reaches the seat as is.
test('a remote seat path image is read on its terminal through transport.readSeatImage', async () => {
  const ctx = context(), actual = Promise.withResolvers(), asked = []
  ctx.actualCompletion = actual.promise
  const gate = { beginSave: async () => ({}), trackCompletion: () => {}, assertSave: () => {}, endSave: async () => {} }
  const bot = { id: 'bot-remote', terminalId: 'mac', projectRoot: '/Users/x/p' }
  const services = { conversationAssetGate: gate, conversationCompletion: () => actual.promise, bots: new Map([[bot.id, bot]]),
    seatRuntime: { readImage: async () => assert.fail('the body must not open a terminal path') },
    transport: { readSeatImage: async (seat, path, maxBytes) => { asked.push([seat, path, maxBytes]); if (path.endsWith('.txt')) throw new Error('IMAGE_PATH_NOT_ALLOWED'); return Buffer.from('shot') } } }
  const adapter = createConversationParentEffects({ getServices: () => services })
  const read = async path => adapter('runtime.image.read', { leaseId: (await adapter('assets.beginSave', { owner: bot.id }, ctx)).leaseId, image: { path } }, ctx)
  assert.deepEqual(await read('/tmp/x.png'), { data: Buffer.from('shot').toString('base64') })
  await assert.rejects(read('/etc/x.txt'), { message: 'IMAGE_PATH_NOT_ALLOWED' })
  assert.deepEqual(asked, [[bot, '/tmp/x.png', 25 * 1024 * 1024], [bot, '/etc/x.txt', 25 * 1024 * 1024]])
})
