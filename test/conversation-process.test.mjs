import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createConversationProcess } from '../src/conversation-process.mjs'
import { createConversationParentChannel, waitConversationChildClose } from '../src/conversation-ipc.mjs'
import { ConversationLifetimes } from '../src/conversation-lifetimes.mjs'

const sha = 'a'.repeat(64), turn = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-process-'))
  const fixture = JSON.parse(await readFile(new URL('../src/conversation/probe-fixture.json', import.meta.url), 'utf8'))
  await mkdir(join(root, 'state'))
  for (const [relative, data] of Object.entries(fixture.files)) {
    await mkdir(dirname(join(root, relative)), { recursive: true })
    await writeFile(join(root, relative), JSON.stringify(data) + '\n', { mode: 0o600 })
  }
  const children = [], closed = [], prepared = [], tokens = new WeakMap(), calls = [], native = []
  const admission = new ConversationLifetimes('initial'), operationContext = {}, admissionCheck = () => {}
  let snapshotReads = 0
  const ports = { root, admission, readBots: () => { snapshotReads++; return fixture.bots },
    authorizeActor: (method, token) => tokens.get(token)?.method === method ? tokens.get(token).actor : false,
    onEffect: async (method, params, context) => {
      calls.push({ method, params, context })
      if (method === 'members.profiles.read') return { bots: fixture.bots }
      if (method === 'execution.assertAccess') return { allowed: true }
      if (method === 'usage.routing.read') return { enabled: false, epoch: 1, apiKey: null }
      if (method.startsWith('usage.notify.')) return { accepted: true }
      if (method === 'execution.turn') {
        admission.claimNative(context.conversationDelivery, { deliveryId: params.deliveryId, target: params.target, kind: 'turn' })
        native.push({ delivery: context.conversationDelivery, params }); return { delivery: 'running' }
      }
      throw new Error('unexpected parent effect')
    },
    prepareRelease: async versionId => { prepared.push(versionId); return { versionId, appRoot: `/run/bellteam-maintenance/conversation/releases/${versionId}/payload` } },
    spawnProcess: (entry, args, options) => {
      assert.equal(entry, '/usr/local/libexec/bellteam-conversation-start')
      assert.deepEqual(options.env, {}); assert.equal(options.serialization, 'advanced')
      for (const old of children) { assert.ok(old.exitCode !== null || old.signalCode !== null); assert(old.stdout.closed && old.stderr.closed && !old.connected) }
      const child = spawn(process.execPath, [new URL('./fixtures/conversation-channel-child.mjs', import.meta.url).pathname, root, args[0]], options)
      children.push(child); closed.push(waitConversationChildClose(child)); return child
    },
  }
  let controller = createConversationProcess(ports)
  t.after(async () => { await controller.close(); await Promise.all(closed); await rm(root, { recursive: true, force: true }) })
  const options = (method, lease) => {
    const token = {}; tokens.set(token, { method, actor: { kind: 'owner' } })
    return { conversationLease: lease, capturedAuthority: token, operationContext, admissionCheck }
  }
  const request = async (method, params) => {
    const lease = admission.enter()
    try { return await controller.request(method, params, options(method, lease)) } finally { admission.finish(lease) }
  }
  return { root, fixture, admission, controller, ports, children, closed, calls, native, prepared, options, request,
    operationContext, admissionCheck, snapshotReads: () => snapshotReads,
    reload() { controller = createConversationProcess(ports); this.controller = controller; return controller },
  }
}

test('conversation wrapper performs real Node builtin/release/builtin restore and reload with one writer', { timeout: 10000 }, async t => {
  const h = await fixture(t)
  await h.controller.start()
  assert.equal((await h.request('rooms.list', {})).rooms.length, 1)
  const bot = h.fixture.bots[0].id
  await h.request('direct.post', { from: bot, target: 'user', message: 'preserved across exchange', images: [] })
  const before = await readFile(join(h.root, 'logs/direct-messages.jsonl'))
  await h.controller.replace(sha)
  assert.equal(h.controller.snapshot().currentVersionId, sha)
  assert.deepEqual(await readFile(join(h.root, 'logs/direct-messages.jsonl')), before)
  await h.controller.replace('builtin')
  assert.equal(h.controller.snapshot().currentVersionId, null)
  assert.equal(h.snapshotReads(), 3)
  assert.deepEqual(JSON.parse(await readFile(join(h.root, 'state/conversation-release.json'), 'utf8')), {
    schema: 'bellteam.conversation.adoption.v1', currentVersionId: null, previousVersionId: sha,
  })
  await h.controller.close(); await h.reload().start()
  assert.equal((await h.request('rooms.list', {})).rooms.length, 1)
  assert.deepEqual(await readFile(join(h.root, 'logs/direct-messages.jsonl')), before)
})

test('wrapper retains accepted save/native completion and permits only the old live lease during exchange', { timeout: 10000 }, async t => {
  const h = await fixture(t)
  const refused = h.controller.request('user.turn', {})
  assert.equal(refused.accepted, refused); assert.equal(refused.completion, refused)
  await assert.rejects(refused.accepted, { code: 'CONVERSATION_NOT_ACCEPTING' })
  await h.controller.start()
  const lease = h.admission.enter(), input = { target: h.fixture.bots[0].id, message: 'question', images: [] }
  const options = h.options('user.turn', lease), request = h.controller.request('user.turn', input, options)
  await request.accepted
  const replacing = h.controller.replace(sha)
  while (h.controller.snapshot().phase !== 'quiescing') await turn()
  assert.throws(() => h.admission.enter())
  assert.equal((await h.controller.request('rooms.list', {}, h.options('rooms.list', lease))).rooms.length, 1)
  assert.equal(h.children.length, 1)
  for (const call of h.calls) { assert.equal(call.context.operationContext, h.operationContext); assert.equal(call.context.admissionCheck, h.admissionCheck) }
  await h.admission.invoke(h.native[0].delivery, 'user.complete', { reply: 'saved before exchange' })
  h.admission.finish(h.native[0].delivery)
  await request; h.admission.finish(lease)
  await replacing
  assert.equal(h.children.length, 2)
  assert((await readFile(join(h.root, 'logs/direct-messages.jsonl'), 'utf8')).includes('saved before exchange'))
})

test('explicit quiesce deadline rejects the caller while actual completion remains pending', { timeout: 4000 }, async t => {
  const h = await fixture(t)
  const child = spawn(process.execPath, [new URL('./fixtures/conversation-channel-child.mjs', import.meta.url).pathname, h.root, 'builtin', '80'],
    { env: {}, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout.resume(); child.stderr.resume()
  const ended = waitConversationChildClose(child), generation = 'deadline'
  const channel = createConversationParentChannel(child, { generation, admission: new ConversationLifetimes(generation), authorizeActor: () => false, onEffect: () => { throw new Error('forbidden') } })
  t.after(async () => { if (child.connected) await channel.control('exit'); await ended; await channel.drainIncoming(); await channel.reaped() })
  await channel.control('initialize', { generation, mode: 'restore', bots: h.fixture.bots }); await channel.ready; await channel.control('resume')
  const waiting = channel.control('quiesce', {}, 15)
  let complete = false
  waiting.completion.then(() => { complete = true })
  await assert.rejects(waiting, { code: 'CONVERSATION_IPC_TIMEOUT' })
  assert.equal(complete, false)
  assert.deepEqual(await waiting.completion, { quiesced: true })
})

test('fixed probe refuses caller arguments before trying the fixed C entry', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, [new URL('../scripts/probe-conversation-runtime.mjs', import.meta.url).pathname, '--root=forged'], { env: {} }),
    error => error.stderr.includes('CONVERSATION_PROBE_ENVIRONMENT') && !error.stderr.includes('ENOENT'))
})


test('automatic recovery restores conversation in the same durable root', { timeout: 10000 }, async t => {
  const h = await fixture(t); await h.controller.start()
  const before = h.controller.snapshot().generation
  h.children[0].kill('SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 1400))
  assert.equal(h.children.length, 2)
  assert.equal(h.controller.snapshot().available, true)
  assert.notEqual(h.controller.snapshot().generation, before)
  assert.equal((await h.request('rooms.list', {})).rooms.length, 1)
  assert.equal(h.native.length, 0)
})
