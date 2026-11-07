import assert from 'node:assert/strict'
import test from 'node:test'
import { AitermGenerationClient, standbyAitermOptions, runtimeAdoption } from '../src/aiterm-generation-client.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fake(id) {
  const capture = { generation: id, components: {} }
  const sdk = { id: `${id}-sdk` }, transport = { id: `${id}-transport` }, connecting = { id: `${id}-connecting` }
  const handoff = { id: `${id}-handoff`, expected: { sdk, transport } }
  const auth = { id: `${id}-auth` }, options = { id: `${id}-options` }
  const calls = [], connected = { id: `${id}-connected` }
  const client = {
    client: sdk, transport, connecting,
    runtime: () => capture,
    captureHandoffConnection: () => handoff,
    prepareAuthConnection: () => auth,
    authOptions: () => options,
    launchOptions: async () => ({ id: `${id}-launch` }),
    connect: () => connected,
    call: (...args) => { calls.push(args); return { id: `${id}-call` } },
    close: () => { client.closed = true },
    calls,
  }
  return { client, capture, runtimeCapture: capture, sdk, transport, connecting, handoff, auth, options, connected }
}

test('pins retain original client identities and helpers while new work follows publication', async () => {
  const old = fake('old'), next = fake('next')
  const facade = new AitermGenerationClient(old)
  const pin = facade.pin()
  facade.publishGeneration(next)

  assert.equal(pin.generation, 'old')
  assert.equal(pin.client, old.sdk)
  assert.equal(pin.sdk, old.sdk)
  assert.equal(pin.transport, old.transport)
  assert.equal(pin.connecting, old.connecting)
  assert.equal(pin.runtime(), old.capture)
  assert.equal(pin.captureHandoffConnection(), old.handoff)
  assert.equal(pin.prepareAuthConnection(), old.auth)
  assert.equal(pin.authOptions(), old.options)
  assert.deepEqual(await pin.launchOptions(), { id: 'old-launch' })
  assert.equal(pin.connect(), old.connected)
  assert.deepEqual(pin.call('pty_send', { session_id: 'seat' }), { id: 'old-call' })
  assert.equal(facade.generation(), 'next')
  assert.equal(facade.call('pty_list').id, 'next-call')
  assert.equal(old.client.calls.length, 1)
  assert.equal(next.client.calls.length, 1)
  pin.release()
})

test('ordinary calls return the original promise and hold a reference through completion', async () => {
  const current = fake('current'), completion = deferred()
  const original = Promise.resolve({ accepted: true })
  original.completion = completion.promise
  current.client.call = () => original
  const facade = new AitermGenerationClient(current)

  const returned = facade.call('agent_launch')
  assert.equal(returned, original)
  assert.equal(facade.references()[0].references, 1)
  await returned
  assert.equal(facade.references()[0].references, 1)
  completion.resolve()
  await completion.promise
  await Promise.resolve()
  assert.equal(facade.references()[0].references, 0)
})

test('retirement waits for the last lease and duplicate release is harmless', async () => {
  const old = fake('old'), next = fake('next'), facade = new AitermGenerationClient(old)
  const pin = facade.pin()
  facade.publishGeneration(next)
  let retired = false
  const retirement = facade.retireGeneration('old', async (client, capture) => {
    retired = true
    assert.equal(client, old.client)
    assert.equal(capture, old.capture)
  })
  await Promise.resolve()
  assert.equal(retired, false)
  pin.release(); pin.release()
  await retirement
  assert.deepEqual(facade.references(), [{ generation: 'next', current: true, references: 0 }])
  assert.equal(facade.generation(), 'next')
})

test('failed retirement keeps the old record retryable without affecting current', async () => {
  const old = fake('old'), next = fake('next'), facade = new AitermGenerationClient(old)
  facade.publishGeneration(next)
  await assert.rejects(facade.retireGeneration('old', async () => { throw new Error('retire failed') }), /retire failed/)
  assert.deepEqual(facade.references(), [
    { generation: 'old', current: false, references: 0 },
    { generation: 'next', current: true, references: 0 },
  ])
  await facade.retireGeneration('old', async client => { assert.equal(client, old.client) })
  assert.equal(facade.generation(), 'next')
  assert.equal(next.client.closed, undefined)
})

test('standby options append lifecycle argv to the native registration only', () => {
  const base = { command: '/node', args: ['/d/execution-native-server.js', '--execution-interrupt', '--state-root', '/s'], seatProject: '/p' }
  const standby = standbyAitermOptions(base, { generation: 'g2', scope: 'scope-a' })
  assert.deepEqual(standby.args.slice(-6), ['--runtime-adoption', 'standby', '--runtime-generation', 'g2', '--runtime-scope', 'scope-a'])
  assert.equal(standby.seatProject, '/p')
  assert.deepEqual(base.args.length, 4)
  assert.throws(() => standbyAitermOptions({ command: 'aiterm-mcp', args: [] }, { generation: 'g2', scope: 's' }), /AITERM_STANDBY_INVALID/)
  assert.throws(() => standbyAitermOptions(base, { generation: 'bad gen', scope: 's' }), /AITERM_STANDBY_INVALID/)
})

test('runtimeAdoption returns the product result and maps refusals to error codes', async () => {
  const ok = { structuredContent: { schema: 'aiterm.runtime-adoption.v1', disposition: 'activated' } }
  assert.equal((await runtimeAdoption({ call: async (name, input) => (assert.equal(name, 'runtime_adoption'), assert.equal(input.action, 'status'), ok) },
    { action: 'status', job_id: 'j' })).disposition, 'activated')
  await assert.rejects(runtimeAdoption({ call: async () => { throw new Error(JSON.stringify({ error_code: 'RUNTIME_ADOPTION_CONFLICT' })) } }, { action: 'activate' }),
    error => error.code === 'RUNTIME_ADOPTION_CONFLICT')
  await assert.rejects(runtimeAdoption({ call: async () => ({ structuredContent: {} }) }, { action: 'status' }), error => error.code === 'RUNTIME_ADOPTION_RESULT_INVALID')
})

test('body-level seat settings follow the current client for dispatcher inheritance', () => {
  const current = fake('current')
  current.client.seatProject = '/srv/bellteam'
  current.client.environmentReady = async () => 'ready'
  const facade = new AitermGenerationClient(current)
  const inherited = Object.create(facade)
  assert.equal(inherited.seatProject, '/srv/bellteam')
  assert.equal(inherited.environmentReady, current.client.environmentReady)
})
