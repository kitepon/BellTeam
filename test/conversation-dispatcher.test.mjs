import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createConversationDispatcher } from '../src/conversation/dispatcher.mjs'
import { CONVERSATION_STATE_COMPATIBILITY } from '../src/conversation/state-compatibility.mjs'

const generation = 'generation-a'
const controlContext = { generation, operationId: null }
const owner = { kind: 'owner' }, observer = { kind: 'observer' }
const deferred = () => Promise.withResolvers()
const settle = () => new Promise(resolve => setImmediate(resolve))
async function fingerprint(root) {
  const result = {}
  for (const name of await readdir(root)) {
    const path = join(root, name), info = await stat(path, { bigint: true })
    result[name] = { mode: info.mode, mtime: `${info.mtimeNs}`, value: info.isDirectory() ? await fingerprint(path) : (await readFile(path)).toString('base64') }
  }
  return result
}
async function setup(t, override = () => {}, mutate = () => {}) {
  const fixture = JSON.parse(await readFile(new URL('../src/conversation/probe-fixture.json', import.meta.url), 'utf8'))
  mutate(fixture)
  const root = await mkdtemp(join(tmpdir(), 'conversation-dispatcher-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [relative, value] of Object.entries(fixture.files)) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  }
  const calls = [], events = [], native = [], backgrounds = []
  let serial = 0
  const d = createConversationDispatcher({ root, event: async (...args) => events.push(args),
    trackBackground: (id, context, task) => { backgrounds.push({ id, context, task }); task.catch(() => {}) },
    effect: async (method, params, context) => {
      calls.push({ method, params, context })
      if (['execution.turn', 'execution.notify', 'execution.report'].includes(method)) native.push({ method, params, context })
      const result = await override(method, params, context)
      if (result !== undefined) return result
      if (method === 'members.profiles.read') return { bots: fixture.bots }
      if (method === 'execution.assertAccess') return { allowed: true }
      if (method === 'usage.routing.read') return { enabled: false, epoch: 1, apiKey: null }
      if (method.startsWith('usage.notify.')) return { accepted: true }
      if (['execution.turn', 'execution.notify', 'execution.report'].includes(method)) {
        return { delivery: 'running' }
      }
      if (method === 'execution.background.begin') return { backgroundId: `background-${++serial}` }
      if (method === 'execution.background.end') return { requested: true }
      if (method === 'execution.observation.source') return { deliveryId: `observer-${++serial}`, target: params.target }
      if (method === 'runtime.observer.changed') return { changed: false }
      if (method === 'execution.shown.read') return null
      if (method === 'runtime.room.context') return { turns: [{ speaker: params.speaker, text: params.text }] }
      throw new Error(`Unexpected effect ${method}`)
    } })
  let operation = 0
  const dispatch = (method, params, actor = owner) => {
    const context = { generation, operationId: `operation-${++operation}`, actor, continuation: false }
    d.validateRequest(method, params, context)
    return d.dispatch(method, params, context)
  }
  const callback = (delivery, kind, params) => d.dispatchCallback(kind, params, {
    generation, operationId: delivery.context.operationId, deliveryId: delivery.params.deliveryId,
    target: delivery.params.target, callbackKind: kind,
  })
  const release = delivery => d.releaseDelivery({ generation, operationId: delivery.context.operationId,
    deliveryId: delivery.params.deliveryId, target: delivery.params.target })
  return { root, fixture, d, calls, events, native, backgrounds, dispatch, callback, release }
}
async function initialize(h) {
  await h.d.control('initialize', { generation, mode: 'restore', bots: h.fixture.bots }, controlContext)
  await h.d.control('resume', {}, controlContext)
}

test('dispatcher restore has no effects/writes and history holds one complete snapshot through quiesce', async t => {
  const h = await setup(t), before = await fingerprint(h.root)
  const ready = await h.d.control('initialize', { generation, mode: 'restore', bots: h.fixture.bots }, controlContext)
  assert.deepEqual(ready.stateCompatibility, CONVERSATION_STATE_COMPATIBILITY)
  assert.deepEqual(h.calls, []); assert.deepEqual(h.events, [])
  assert.deepEqual(await fingerprint(h.root), before)
  assert.throws(() => h.d.validateRequest('rooms.list', {}, { generation, operationId: 'x', actor: owner, continuation: false }), /UNAVAILABLE/)
  await h.d.control('resume', {}, controlContext)
  const botId = h.fixture.bots[0].id
  await h.dispatch('direct.post', { from: botId, target: 'user', message: 'first', images: [] })
  const snapshot = await h.dispatch('history.listMessages', { botId })
  await h.dispatch('direct.post', { from: botId, target: 'user', message: 'second', images: [] })
  let drained = false
  const quiesce = h.d.control('quiesce', {}, controlContext).then(value => { drained = true; return value })
  await settle(); assert.equal(drained, false)
  const items = []; for await (const item of snapshot) items.push(item)
  assert.deepEqual(items.map(x => x.message), ['first'])
  assert.deepEqual(await quiesce, { quiesced: true })
  await h.d.control('resume', {}, controlContext)
  const next = await h.dispatch('history.listMessages', { botId }), all = []
  for await (const row of next) all.push(row)
  assert.deepEqual(all.map(x => x.message), ['first', 'second'])
})

test('user acceptance releases independently; registered completion saves and claims an explicit reply once', async t => {
  const h = await setup(t); await initialize(h)
  const target = h.fixture.bots[0].id
  const first = h.dispatch('user.turn', { target, message: 'one', images: [] })
  const second = h.dispatch('user.turn', { target, message: 'two', images: [] })
  assert.equal(typeof first.accepted?.then, 'function')
  await Promise.all([first.accepted, second.accepted])
  let saved = false; first.then(() => { saved = true })
  await settle(); assert.equal(saved, false)
  await h.dispatch('direct.post', { from: target, target: 'user', message: 'explicit', images: [] })
  const firstDelivery = h.native.find(value => value.params.queue.message === 'one')
  const secondDelivery = h.native.find(value => value.params.queue.message === 'two')
  await h.callback(firstDelivery, 'user.complete', { reply: 'native-one' })
  await h.callback(secondDelivery, 'user.complete', { reply: 'native-two' })
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.reply, 'explicit'); assert.equal(b.reply, 'native-two')
  assert.notEqual(a.reply_id, b.reply_id)
  await assert.rejects(h.callback(firstDelivery, 'user.complete', { reply: 'again' }), /PROTOCOL_INVALID/)
  await Promise.all(h.backgrounds.map(x => x.task))
  let drained = false
  const quiesce = h.d.control('quiesce', {}, controlContext).then(value => { drained = true; return value })
  await settle(); assert.equal(drained, false)
  h.native.forEach(h.release)
  assert.deepEqual(await quiesce, { quiesced: true })
})

test('pending background begin holds the final save ACK and resume invalidates an older quiesce', async t => {
  const begin = deferred()
  const h = await setup(t, method => method === 'execution.background.begin' ? begin.promise : undefined)
  await initialize(h)
  const target = h.fixture.bots[0].id, turn = h.dispatch('user.turn', { target, message: 'Q', images: [] })
  await turn.accepted
  let acknowledged = false
  const callback = h.callback(h.native[0], 'user.complete', { reply: 'answer' }).then(value => { acknowledged = true; return value })
  await settle(); assert.equal(acknowledged, false)
  const draining = h.d.control('quiesce', {}, controlContext)
  const rejected = assert.rejects(draining, /QUIESCE_SUPERSEDED/)
  await h.d.control('resume', {}, controlContext)
  begin.resolve({ backgroundId: 'background-delayed' })
  await callback; await turn
  h.release(h.native[0]); await rejected
  await h.d.control('quiesce', {}, controlContext)
  assert.deepEqual(await h.d.control('exit', {}, controlContext), { closed: true })
})

test('same-room posts retain order, partial fanout and assigned reply/silent authorization', async t => {
  const firstContext = deferred(), entered = deferred(), order = []
  const h = await setup(t, async (method, params) => {
    if (method === 'execution.notify' && params.target === 'bot-other') throw new Error('target unavailable')
    if (method === 'runtime.room.context') {
      order.push(params.text)
      if (params.text === 'first') { entered.resolve(); await firstContext.promise }
    }
  }, fixture => {
    fixture.bots.push({ id: 'bot-other', name: 'Other' })
    fixture.files['rooms/room-conversation-probe/room.json'].memberIds.push('bot-other')
  })
  await initialize(h)
  const room = 'room-conversation-probe', target = h.fixture.bots[0].id
  const first = h.dispatch('room.post', { from: 'user', room, message: 'first', images: [], targets: [target] })
  await entered.promise
  const second = h.dispatch('room.post', { from: 'user', room, message: 'second', images: [], targets: [target] })
  await settle(); assert.deepEqual(order, ['first'])
  firstContext.resolve(); const [a] = await Promise.all([first, second])
  assert.deepEqual(order, ['first', 'second'])
  assert.equal(a.delivery, 'posted_with_failed_deliveries')
  assert.deepEqual(a.failedTargets, [{ id: 'bot-other', error: 'target unavailable' }])
  assert.equal(h.native.length, 4)
  assert.deepEqual(await h.dispatch('room.silent', { roomId: room, messageId: a.id }, { kind: 'bot', botId: 'bot-other' }), { delivery: 'suppressed' })
  await assert.rejects(h.dispatch('room.reply', { roomId: room, messageId: a.id, message: 'no', images: [] }, { kind: 'bot', botId: 'bot-other' }), /NOT_ASSIGNED/)
  await assert.rejects(h.dispatch('room.update', { roomId: room, changes: { name: 'no' } }, { kind: 'bot', botId: 'bot-other' }), /REPRESENTATIVE/)
  h.native.forEach(h.release)
  await h.d.control('quiesce', {}, controlContext)
})

test('user.post keeps saving after its accepted root has returned', async t => {
  const h = await setup(t); await initialize(h)
  const target = h.fixture.bots[0].id
  assert.equal((await h.dispatch('user.post', { target, message: 'Q', images: [] })).delivery, 'running')
  await h.callback(h.native[0], 'user.complete', { reply: 'saved later' })
  const stream = await h.dispatch('history.listMessages', { botId: target }), rows = []
  for await (const row of stream) rows.push(row)
  assert.equal(rows.at(-1).message, 'saved later')
  h.release(h.native[0]); await h.d.control('quiesce', {}, controlContext)
})

test('each admitted image read uses its own parent save lease and rejects a bot saving for another owner', async t => {
  const h = await setup(t, (method, params, context) => {
    if (method === 'assets.beginSave') return { leaseId: `lease-${context.operationId}` }
    if (method === 'runtime.image.read') {
      assert.equal(params.leaseId, `lease-${context.operationId}`)
      assert.deepEqual(Object.keys(params).sort(), ['image', 'leaseId'])
      return { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') }
    }
    if (method === 'assets.endSave') { assert.equal(params.leaseId, `lease-${context.operationId}`); return { requested: true } }
  })
  await initialize(h)
  const input = { owner: 'user', id: 'image-a', image: { path: '/parent/image.png' } }
  await Promise.all([h.dispatch('assets.save', input), h.dispatch('assets.save', { ...input, id: 'image-b' })])
  assert.equal(h.calls.filter(x => x.method === 'runtime.image.read').length, 2)
  await assert.rejects(h.dispatch('assets.save', input, { kind: 'bot', botId: h.fixture.bots[0].id }), /OWNER_FORBIDDEN/)
  await h.d.control('quiesce', {}, controlContext)
})

test('observer uses parent read/source and stores cursor before acknowledging, without project paths', async t => {
  const h = await setup(t, (method, params) => {
    if (method === 'runtime.observer.snapshot') return { projects: [{ botId: h.fixture.bots[0].id, scope: 'tlop1.' + 'a'.repeat(64), projectBytes: 20 }] }
    if (method === 'runtime.observer.check') return { schema: 'throughline.observer_check_result.v1', status: 'complete', results: params.projects.map(item => ({ id: item.id, status: 'changed', token: 'tloc1.new' })) }
    if (method === 'runtime.observer.read') {
      assert.equal(Object.hasOwn(params, 'project'), false)
      return { status: 'delta', throughCursor: 'cursor-new', page: { complete: true }, turns: [
        { source_sha256: 'sha', turn_start: 'self', user: '', assistant: 'self answer', completed_at: 1000 },
      ] }
    }
  }, fixture => { fixture.files['logs/self-turns.json'].bots[fixture.bots[0].id].cursor = 'cursor-old' })
  await initialize(h)
  assert.deepEqual(await h.dispatch('observation.poll', {}, observer), { applied: true })
  assert.equal(JSON.parse(await readFile(join(h.root, 'logs/self-turns.json'), 'utf8')).bots[h.fixture.bots[0].id].cursor, 'cursor-new')
  assert.equal(h.calls.filter(x => x.method === 'execution.observation.source').length, 1)
  assert.equal(h.calls.filter(x => x.method === 'execution.background.begin').length, 1)
  await h.d.control('quiesce', {}, controlContext)
})
