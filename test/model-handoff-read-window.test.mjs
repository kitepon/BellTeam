import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises'
import { ModelHandoff } from '../src/model-handoff.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const controller = new AbortController(), window = new AbortController(), tracks = [], effects = []
  const current = { id: 'bot-one', harness: 'codex' }, launch = { session_id: 'seat', launch_id: 'launch' }
  const nativeCall = { server_instance: 'server', thread_id: 'thread', turn_id: 'turn', call_id: 'call',
    call_token: 'token', source: { kind: 'direct' } }
  const anchor = { deliveryId: 'delivery', target: current.id, context: 'direct', contextId: current.id }
  const captured = { status: 'captured', launch, native_call: nativeCall,
    point: { boundary: { event_cursor: 42, turn_id: 'turn' } }, anchor: { client_delivery_id: 'delivery' },
    process: { harness: { pid: 1, start_identity: 'h' }, backend: { pid: 2, start_identity: 'b' } } }
  const binding = { currentConnection: () => binding, capture: () => Promise.resolve(captured) }
  const transport = { client: { captureHandoffConnection: () => binding }, session: () => 'seat', isRunning: async () => true,
    jobs: new Set([{ bot: current, receipt: { ...launch, mode: 'agent_dispatch', event_cursor: 42 },
      info: { groupId: 'delivery', context: 'direct', contextId: current.id } }]) }
  const handoff = new ModelHandoff({ transport, records: new Map(), trackCompletion: p => tracks.push(p),
    readAnchor: () => Promise.resolve(anchor), requests: {
      async prepareHandoff() { effects.push('prepare'); return { binding: { id: 'original', digest: 'digest' } } },
    } })
  const ingress = { schema: 'bellteam.mcp-configuration-ingress.v1', actor: { kind: 'bot', botId: current.id },
    toolName: 'update_self', originalMcpRequestId: 73, expectedLaunch: null, nativeCall, signal: controller.signal, budget: null }
  const prepare = deadline => handoff.prepare({ botId: current.id, current, candidate: current, ingress,
    assertCurrent() {}, deadline, windowSignal: window.signal })
  return { controller, window, tracks, effects, binding, handoff, anchor, captured, prepare, current, transport, ingress }
}

// No child abort support: the original result and completion remain independently pending.
for (const trigger of ['deadline', 'original-abort', 'metadata-window']) {
  for (const late of ['resolve', 'reject']) {
    test(`read ${trigger}: caller returns before real completion; late ${late} cannot prepare`, { timeout: 2000 }, async () => {
      const f = fixture(), result = deferred(), completion = deferred(), started = deferred()
      let realEnded = false, readSignal
      completion.promise.then(() => { realEnded = true })
      result.promise.completion = completion.promise
      f.handoff.readAnchor = (_anchor, options) => { readSignal = options.signal; started.resolve(); return result.promise }
      const pending = f.prepare(performance.now() + (trigger === 'deadline' ? 35 : 1000))
      await started.promise
      if (trigger === 'original-abort') f.controller.abort()
      if (trigger === 'metadata-window') f.window.abort()
      assert.equal(await pending, null)
      assert.equal(readSignal.aborted, true)
      assert.equal(realEnded, false)
      assert(f.tracks.includes(completion.promise))
      assert(!f.tracks.includes(result.promise))
      assert.deepEqual(f.effects, [])
      if (late === 'resolve') result.resolve(f.anchor)
      else result.reject(Error('late read rejection'))
      await turn()
      assert.deepEqual(f.effects, [])
      assert.equal(realEnded, false)
      completion.resolve(); await turn(); assert.equal(realEnded, true)
      for (const signal of [f.controller.signal, f.window.signal, readSignal]) assert.equal(getEventListeners(signal, 'abort').length, 0)
    })
  }
}

test('normal read preserves metadata and tracks real read completion beyond result', async () => {
  const f = fixture(), completion = deferred()
  const result = Promise.resolve(f.anchor); result.completion = completion.promise
  f.handoff.readAnchor = () => result
  const prepared = await f.prepare(performance.now() + 1000)
  assert.equal(prepared.metadata.call_token, 'token')
  assert.deepEqual(f.effects, ['prepare'])
  assert(f.tracks.includes(completion.promise))
  completion.resolve()
})

test('capture and read share the original deadline; late capture never starts read', { timeout: 2000 }, async () => {
  const f = fixture(), capture = deferred()
  f.binding.capture = () => capture.promise
  let reads = 0
  f.handoff.readAnchor = () => { reads++; return Promise.resolve(f.anchor) }
  const pending = f.prepare(performance.now() + 30)
  assert.equal(await pending, null)
  assert(f.tracks.includes(capture.promise))
  capture.resolve(f.captured); await turn()
  assert.equal(reads, 0); assert.deepEqual(f.effects, [])

  const g = fixture(), reading = deferred()
  let deadline, readStarted
  g.binding.capture = async () => { await delay(20); return g.captured }
  g.handoff.readAnchor = () => { readStarted = performance.now(); return reading.promise }
  deadline = performance.now() + 60
  assert.equal(await g.prepare(deadline), null)
  assert(readStarted < deadline)
  reading.resolve(g.anchor); await turn()
  assert.deepEqual(g.effects, [])
})

for (const superseded of [false, true]) {
  test(`expired read follows ordinary apply once; superseded=${superseded}`, async () => {
    const f = fixture(), reading = deferred(), started = deferred(), completion = deferred()
    reading.promise.completion = completion.promise
    f.handoff.readAnchor = () => { started.resolve(); return reading.promise }
    const bots = new Map([[f.current.id, f.current]])
    bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
    bots.update = async (id, changes) => { const bot = { ...bots.get(id), ...changes }; bots.set(id, bot); return bot }
    let applies = 0
    f.transport.reconfigure = async (_old, _new, options) => { options.admissionCheck(); applies++; return {} }
    const admin = new BotAdministration({ bots, transport: f.transport, writeLog() {}, trackCompletion: p => f.tracks.push(p) })
    f.handoff.records = admin.automaticConfigurationOperations
    admin.handoff = f.handoff
    const response = admin.configureFromMcp(f.current.id, { model: 'new-model' }, f.ingress)
    await started.promise
    if (superseded) bots.set(f.current.id, { ...bots.get(f.current.id), model: 'later-model' })
    f.controller.abort()
    assert.equal((await response).handoffMetadata, null)
    await admin.applicationCompletions.get(f.current.id)
    assert.equal(applies, superseded ? 0 : 1)
    assert(f.tracks.includes(completion.promise))
    reading.resolve(f.anchor); await turn()
    assert.deepEqual(f.effects, [])
    assert.equal(applies, superseded ? 0 : 1)
    completion.resolve()
  })
}
