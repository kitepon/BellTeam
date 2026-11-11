import { ConversationWriter } from '../src/conversation-writer.mjs'
import { MODULE_CONCURRENCY } from '../src/module-ipc.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { serialize, deserialize } from 'node:v8'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fork } from 'node:child_process'
import { createConversationParentChannel, createConversationChildChannel, waitConversationChildClose } from '../src/conversation-ipc.mjs'
import { createConversationDispatcher } from '../src/conversation/dispatcher.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'
import { createConversationObserverParentEffects } from '../src/conversation/observer-parent.mjs'
import { createConversationPeer } from '../src/conversation-channel.mjs'
import { createConversationParentEffects } from '../src/conversation-parent-effects.mjs'
import { validateConversationPageRows, validateConversationRecentRows } from '../src/conversation/results.mjs'
import { createConversationFacade } from '../src/conversation-facade.mjs'
import { createMessageViews } from '../src/http-messages.mjs'
import { createBotConversationApi } from '../src/http-conversation-api.mjs'
import { TimelineIndex } from '../src/timeline-index.mjs'

function pair() {
  const endpoints = [new EventEmitter(), new EventEmitter()]
  for (const [index, endpoint] of endpoints.entries()) {
    endpoint.connected = true
    endpoint.send = (frame, callback) => {
      const value = deserialize(serialize(frame))
      setImmediate(() => { if (endpoint.connected) endpoints[1 - index].emit('message', value); callback?.(endpoint.connected ? null : new Error('disconnected')) })
    }
    endpoint.disconnect = () => { for (const peer of endpoints) { if (peer.connected) { peer.connected = false; peer.emit('disconnect') } } }
  }
  return endpoints
}
const settle = () => new Promise(resolve => setImmediate(resolve))


async function setup(t, { effect = () => {}, event = async () => {}, dispatcher: factory = createConversationDispatcher, forked = false, bots = [] } = {}) {
  const fixture = JSON.parse(await readFile(new URL('../src/conversation/probe-fixture.json', import.meta.url), 'utf8'))
  fixture.bots.push(...bots)
  const root = await mkdtemp(join(tmpdir(), 'conversation-channel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [relative, value] of Object.entries(fixture.files)) {
    const path = join(root, relative); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  }
  const processChild = forked ? fork(new URL('./fixtures/conversation-channel-child.mjs', import.meta.url), [root], {
    serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
  }) : null
  const closed = processChild ? waitConversationChildClose(processChild) : null
  let childErrors = ''
  processChild?.stderr.on('data', chunk => { childErrors += chunk })
  const endpoints = processChild ? [processChild] : pair(), generation = 'generation-a', admission = new ConversationLifetimes(generation), tokens = new WeakMap(), calls = [], native = [], diagnostics = []
  const logWriter = new ConversationWriter({ logPath: join(root, 'logs/direct-messages.jsonl'), onMessage: () => {} })
  let child, parent
  const dispatcher = processChild ? null : factory({ root, effect: (...args) => child.effect(...args), event: (...args) => child.event(...args),
    trackBackground: (...args) => child.trackBackground(...args), diagnostic: report => child.diagnostic(report) })
  if (dispatcher) child = createConversationChildChannel({ dispatcher, endpoint: endpoints[1], versionId: null })
  parent = createConversationParentChannel(endpoints[0], { generation, admission,
    onDiagnostic: report => { diagnostics.push(report) },
    onEvent: event,
    authorizeActor: (method, token) => tokens.get(token)?.method === method ? tokens.get(token).actor : false,
    onEffect: async (method, params, context) => {
      calls.push({ method, params, context })
      if (method === 'direct.log.append') { await logWriter.append(params.record); return { applied: true } }
      const override = await effect(method, params, context)
      if (override !== undefined) return override
      if (method === 'members.profiles.read') return { bots: fixture.bots }
      if (method === 'execution.assertAccess') return { allowed: true }
      if (method === 'usage.routing.read') return { enabled: false, epoch: 1, apiKey: null }
      if (method.startsWith('usage.notify.')) return { accepted: true }
      if (method === 'runtime.observer.changed') return { changed: false }
      if (method === 'runtime.room.context') return { turns: [{ speaker: params.speaker, text: params.text }] }
      if (['execution.turn', 'execution.notify', 'execution.report'].includes(method)) {
        const delivery = context.conversationDelivery
        admission.claimNative(delivery, { deliveryId: params.deliveryId, target: params.target,
          kind: method === 'execution.turn' ? 'turn' : method === 'execution.report' ? 'report' : 'notify' })
        native.push({ delivery, context, params }); return { delivery: 'running' }
      }
      throw new Error(`Unexpected effect ${method}`)
    } })
  t.after(async () => {
    if (endpoints[0].connected) endpoints[0].disconnect()
    // The only allowed child stderr is its one closed exit-origin line.
    if (closed) { await closed; assert.match(childErrors, /^(?:\{"code":"CONVERSATION_CHILD_EXIT_ORIGIN","origin":"[a-z_]+","failureCode":(?:null|"[A-Z_]+")\}\n)?$/u) }
    await parent.drainIncoming(); await parent.reaped()
  })
  await parent.control('initialize', { generation, mode: 'restore', bots: fixture.bots })
  assert.equal((await parent.ready).protocolVersion, 1)
  await parent.control('resume')
  const lease = admission.enter(), operationContext = { opaque: true }, admissionCheck = () => {}
  const request = (method, params, actor = { kind: 'owner' }, extra = {}) => {
    const token = {}; tokens.set(token, { method, actor })
    return parent.request(method, params, { conversationLease: lease, capturedAuthority: token, operationContext, admissionCheck, ...extra })
  }
  return { root, fixture, parent, child, dispatcher, admission, lease, request, calls, native, operationContext, admissionCheck, endpoints, closed, diagnostics }
}


export { setup, createConversationDispatcher }
