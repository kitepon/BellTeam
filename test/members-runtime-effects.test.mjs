import test from 'node:test'
import assert from 'node:assert/strict'
import { SeatRuntime } from '../src/seat-runtime.mjs'
import { createMembersRuntimeEffects } from '../src/members-runtime-effects.mjs'

test('members CLI effects share the original queue and read bot IDs only when their writer starts', async () => {
  let release, entered, first = true, ids = ['bot-old'], reads = 0
  const waiting = new Promise(resolve => { entered = resolve })
  const held = new Promise(resolve => { release = resolve }), calls = []
  const runtime = new SeatRuntime({ root: '/synthetic', home: '/synthetic/home', stream: () => {}, run: async (_node, _args, options) => {
    const input = JSON.parse(options.input); calls.push(input)
    if (first) { first = false; entered(); await held }
    return { stdout: JSON.stringify({ result: null }), stderr: '' }
  } })
  const firstWriter = runtime.writeHarnessConfig(new Map(), {}, { enabled: false })
  await waiting
  const context = { generation: 'fixture', leaseId: 'lease', rootId: '1', ownerWrite: false, continuation: false }
  const effect = createMembersRuntimeEffects({ seatRuntime: runtime, aiterm: { fixed: true }, callBridge: () => ({ enabled: true }),
    readCurrentBotIds: async captured => { assert.equal(captured, context); reads++; return ids } })
  const writing = effect('cli.configure', { botIds: ['bot-old'] }, context)
  assert.equal(reads, 0); ids = ['bot-new']; release()
  await firstWriter; await writing
  assert.equal(reads, 1)
  assert.deepEqual(calls[1].profiles, [{ id: 'bot-new', project: '/synthetic/bots/bot-new' }])
  assert.deepEqual(calls[1].callBridge, { enabled: true })
  await effect('project.writeInstructions', { botId: 'bot-new', body: 'generated' }, context)
  assert.equal(calls[2].action, 'members-project')
  assert.deepEqual(calls[2].params, { botId: 'bot-new', body: 'generated' })
  await assert.rejects(effect('models.read', { harness: 'codex' }, context), { code: 'MEMBERS_EFFECT_UNSUPPORTED' })
})
