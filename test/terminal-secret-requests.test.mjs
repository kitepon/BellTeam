import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretRequests } from '../src/secret-requests.mjs'
import { createUsageServices } from '../src/usage/services.mjs'
import { createUsageAssembly } from '../src/usage-assembly.mjs'
import { usageResultValid } from '../src/usage/process-results.mjs'

const scope = { terminalId: 'synthetic-terminal', purpose: 'terminal.ssh' }
const context = { ...scope, memberId: 'bot-a' }
const reference = `op://${'a'.repeat(26)}/${'b'.repeat(26)}/credential`
const provider = () => ({ available: true, reads: 0, async refresh() {}, close() {}, watch: () => () => {}, async resolve() { this.reads++; return 'synthetic-OpenSSH-key\n' } })
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'terminal-secret-requests-'))
  const bots = new Map([['bot-a', { id: 'bot-a', name: 'A' }]])
  const onePassword = provider(), notify = []
  const service = new SecretRequests({ root, bots, rooms: new Map(), onePassword, credentialRetryMs: 0,
    notify: value => notify.push(value), onRequest: value => notify.push(value) })
  await service.initialize()
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }) })
  return { root, bots, onePassword, notify, service }
}

test('Owner terminal cards bind exact retained SSH/sudo scope and stay outside Bot timelines and notifications', async t => {
  const { service, onePassword, notify } = await fixture(t), events = []
  service.watchCredentials(event => events.push(event))
  const { secretRequest } = await service.requestTerminalKey({ ...scope, purpose: 'ssh-key', label: 'SSH key' })
  assert.equal(secretRequest.botId, null)
  assert.equal(secretRequest.purpose, 'terminal.ssh')
  assert.deepEqual(secretRequest.inputOptions, { preferred: 'onepassword', onePasswordAvailable: true })
  await service.submit(secretRequest.id, { source: 'onepassword', reference })
  const current = await service.currentCredential(scope)
  assert.equal(current.requestId, secretRequest.id)
  assert.deepEqual(events.at(-1), { ...scope, ...current, reason: 'bound' })
  assert.equal(await service.withResolved(current.handle, { ...context, expectedRevision: current.revision }, value => value.endsWith('\n')), true)
  assert.equal(onePassword.reads, 1)
  const sudo = await service.requestTerminalKey({ ...scope, purpose: 'sudo-key', label: 'sudo password' })
  await service.submit(sudo.secretRequest.id, 'synthetic-sudo-password')
  assert.equal((await service.currentCredential({ ...scope, purpose: 'terminal.sudo' })).requestId, sudo.secretRequest.id)
  assert.deepEqual(service.timeline({ botId: 'bot-a' }), [])
  assert.deepEqual(notify, [])
  assert.ok(!JSON.stringify([events, current, secretRequest]).includes(reference))
  await assert.rejects(service.bindCredential(secretRequest.id, { ...scope, terminalId: 'another-terminal' }), { code: 'SECRET_CREDENTIAL_FORBIDDEN' })
})

test('new Owner request cancels pending predecessor; unbind persists revocation and cancels a later pending card', async t => {
  const { root, bots, service } = await fixture(t)
  const first = await service.requestTerminalKey({ ...scope, label: 'A' })
  const second = await service.requestTerminalKey({ ...scope, label: 'B' })
  assert.equal(service.get(first.secretRequest.id).status, 'cancelled')
  await assert.rejects(service.submit(first.secretRequest.id, 'late-A'), /SECRET_REQUEST_CLOSED/)
  await service.submit(second.secretRequest.id, 'selected-B')
  const current = await service.currentCredential(scope)
  await service.requestTerminalKey({ ...scope, label: 'C' })
  const removed = await service.unbindCredential(current.handle, scope)
  assert.equal(removed.available, false)
  assert.equal(await service.currentCredential(scope), null)
  assert.ok([...service.items.values()].every(item => item.status !== 'pending'))
  await assert.rejects(service.withResolved(current.handle, context, () => assert.fail()), { code: 'SECRET_CREDENTIAL_REVOKED' })
  await assert.rejects(service.bindCredential(second.secretRequest.id, scope), { code: 'SECRET_REQUEST_CLOSED' })
  service.close()
  const restored = new SecretRequests({ root, bots, rooms: new Map(), onePassword: provider(), credentialRetryMs: 0, notify() {} })
  t.after(() => restored.close())
  await restored.initialize({ readOnly: true })
  assert.equal(await restored.currentCredential(scope), null)
  await assert.rejects(restored.withResolved(current.handle, context, () => assert.fail()), { code: 'SECRET_CREDENTIAL_REVOKED' })
})

test('stored handle revision expectation rejects stale reads before consuming a changed key', async t => {
  const { service } = await fixture(t)
  const request = await service.requestTerminalKey({ ...scope, label: 'old' })
  await service.submit(request.secretRequest.id, 'old-key')
  const selected = await service.currentCredential(scope)
  const next = await service.requestTerminalKey({ ...scope, label: 'new' })
  await service.submit(next.secretRequest.id, 'new-key')
  const replaced = await service.replaceCredential(selected.handle, next.secretRequest.id, context)
  await assert.rejects(service.withResolved(selected.handle, { ...context, expectedRevision: 1 }, () => assert.fail()), { code: 'SECRET_CREDENTIAL_STALE' })
  assert.equal(await service.withResolved(selected.handle, { ...context, expectedRevision: replaced.revision }, value => value), 'new-key')
})

test('parent terminal-key facade captures authority, publishes correlated selection, and preserves tombstone on restart', async t => {
  const { root, bots } = await fixture(t)
  let ports, service
  const rows = [], effects = []
  const assembly = createUsageAssembly({ root, getServices: () => ({ bots }), onEffect() {},
    createProcess(value) { ports = value; return {
      request(method, params, options) {
        const actor = value.authorizeActor(method, options.capturedAuthorization)
        const run = service.request(method, params, actor).then(result => { assert.ok(usageResultValid(method, result, params), method); return result })
        Object.defineProperty(run, 'completion', { value: run }); return run
      }, async close() { await service.quiesce(); service.close() },
    } } })
  service = createUsageServices({ root, bots, rooms: new Map(), onePassword: provider(), effect: async (method, params) => effects.push({ method, params }),
    onProjection: async row => { rows.push(row); await ports.onProjection(row, { phase: 'update', generation: 'terminal-test' }) } })
  await service.initializeSettings(); await service.initialize()
  ports.onSnapshotStart({ generation: 'terminal-test' })
  for (const row of service.snapshot()) await ports.onProjection(row, { phase: 'snapshot', generation: 'terminal-test' })
  ports.onSnapshotEnd({ generation: 'terminal-test' })
  t.after(() => assembly.close())
  const { secretRequest } = await assembly.credentials.requestTerminalKey({ ...scope, label: 'app key' })
  await assert.rejects(service.request('secrets.get', { id: secretRequest.id }, { kind: 'bot', botId: 'bot-a' }), { code: 'SECRET_REQUEST_NOT_FOUND' })
  await service.request('secrets.submit', { id: secretRequest.id, value: { source: 'onepassword', reference } }, { kind: 'owner', botId: null })
  const current = await assembly.credentials.current(scope)
  assert.equal(current.requestId, secretRequest.id)
  assert.equal(await assembly.credentials.withResolved(current.handle, { ...context, expectedRevision: current.revision }, value => value), 'synthetic-OpenSSH-key\n')
  assert.equal(effects.length, 0)
  assert.ok(!JSON.stringify(rows).includes(reference))
  await assembly.credentials.unbind(current.handle, scope)
  assert.equal(await assembly.credentials.current(scope), null)
  const pending = await assembly.credentials.requestTerminalKey({ ...scope, label: 'delete before first submit' })
  assert.equal(await assembly.credentials.unbind(null, scope), null)
  await assert.rejects(service.request('secrets.submit', { id: pending.secretRequest.id, value: 'too-late' }, { kind: 'owner', botId: null }), /SECRET_REQUEST_CLOSED/)
  assert.equal(await assembly.credentials.current(scope), null)
  const raced = await assembly.credentials.requestTerminalKey({ ...scope, label: 'racing submit' })
  await Promise.allSettled([
    service.request('secrets.submit', { id: raced.secretRequest.id, value: 'race-key' }, { kind: 'owner', botId: null }),
    assembly.credentials.unbind(null, scope),
  ])
  assert.equal(await assembly.credentials.current(scope), null)
  const { NativeSecretCredentials } = await import('../src/usage/native-secret-credentials.mjs')
  const parentRestored = new NativeSecretCredentials({ root })
  t.after(() => parentRestored.close())
  assert.deepEqual(await parentRestored.selection(scope), { present: true, credential: null })
})


test('Owner submitted source survives binding failure and retry binds it without overwriting its value', async t => {
  const { service } = await fixture(t)
  const request = await service.requestTerminalKey({ ...scope, label: 'recover binding' })
  const original = service.bindCredential.bind(service)
  let fail = true
  service.bindCredential = async (...args) => { if (fail) { fail = false; throw new Error('SYNTHETIC_BIND_WRITE_FAILURE') } return original(...args) }
  await assert.rejects(service.submit(request.secretRequest.id, 'retained-key'), /SYNTHETIC_BIND_WRITE_FAILURE/)
  assert.equal(service.get(request.secretRequest.id).status, 'submitted')
  const recovered = await service.currentCredential(scope)
  assert.equal(recovered.requestId, request.secretRequest.id)
  await service.submit(request.secretRequest.id, 'must-not-overwrite')
  assert.equal(await service.withResolved(recovered.handle, context, value => value), 'retained-key')
})

test('parent validates credential projection before durable selection and notifies only after persistence', async () => {
  const { createUsageFacade } = await import('../src/usage/facade.mjs')
  const order = [], row = { type: 'credential', revision: 1, value: { ...scope, handle: 'synthetic-handle', revision: 1, available: true, requestId: 'synthetic-request', reason: 'bound' } }
  const facade = createUsageFacade({ request() {}, projection: { accept() { order.push('validate') } } })
  facade.secretRequests.watchCredentials(() => order.push('notify'))
  await facade.accept(row, 'test', async () => { order.push('persist') })
  assert.deepEqual(order, ['validate', 'persist', 'notify'])
  const stale = createUsageFacade({ request() {}, projection: { accept() { throw new Error('USAGE_PROJECTION_REVISION') } } })
  assert.throws(() => stale.accept(row, 'test', () => order.push('must-not-persist')), /USAGE_PROJECTION_REVISION/)
  assert.equal(order.includes('must-not-persist'), false)
})
