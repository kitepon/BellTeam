import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { BotAdministration } from '../src/bot-administration.mjs'
import { ConfigurationLock } from '../src/configuration-lock.mjs'
import { ConfigurationRequests } from '../src/configuration-requests.mjs'

const noMemory = async () => ''
const lockFixture = async () => new ConfigurationLock(join(await mkdtemp(join(tmpdir(), 'bellteam-lock-')), 'nested', 'lock.key'))
const refusal = () => Object.assign(new Error('AGENT_CONFIGURATION_LOCKED'), { configureRefusal: { code: 'AGENT_CONFIGURATION_LOCKED', relaunch: false } })

test('a314: the key is 64 hex chars, per Bot, and the same after a restart (same secret file)', async () => {
  const lock = await lockFixture()
  const a = await lock.key('bot-a'), b = await lock.key('bot-b')
  assert.match(a, /^[0-9a-f]{64}$/u); assert.notEqual(a, b)
  assert.equal(await new ConfigurationLock(lock.secretPath).key('bot-a'), a)
})

test('a314: setConfigurationLock sends the key to Aiterm only, and a failure means "not locked", never an error', async () => {
  const lock = await lockFixture(), calls = []
  let fail = false
  const client = { async call(name, args) { calls.push([name, args]); if (fail) throw refusal(); return {} } }
  const transport = new AitermTransport({ client, handoffContext: noMemory, configurationLock: lock })
  const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: '/bots/bot-a' }
  assert.equal(await transport.setConfigurationLock(bot, true), true)
  assert.deepEqual(calls[0], ['agent_configure', { session_id: 'bot-a', configuration_lock: 'lock', configuration_lock_key: await lock.key('bot-a') }])
  assert.equal(await transport.setConfigurationLock(bot, false), true)
  assert.equal(calls[1][1].configuration_lock, 'unlock')
  fail = true
  assert.equal(await transport.setConfigurationLock(bot, true), false)
  assert.equal(await new AitermTransport({ client, handoffContext: noMemory }).setConfigurationLock(bot, true), false, 'no key source = no call')
  assert.equal(calls.length, 3)
})

test('a314: a new launch of a locked Bot locks the seat; an unlocked Bot is not locked', async () => {
  for (const locked of [true, false]) {
    const lock = await lockFixture(), calls = []
    const client = { async call(name, args) { calls.push([name, args]); return name === 'agent_launch' ? { structuredContent: { session_id: 'bot-a' } } : {} } }
    const bot = { id: 'bot-a', session: 'bot-a', harness: 'claude', project: await mkdtemp(join(tmpdir(), 'bellteam-lock-wake-')), configurationLocked: locked }
    const transport = new AitermTransport({ client, handoffContext: noMemory, configurationLock: lock, resolveBot: () => bot })
    await transport.wakeNow(bot)
    const lockCalls = calls.filter(([name, args]) => name === 'agent_configure' && args.configuration_lock)
    assert.equal(lockCalls.length, locked ? 1 : 0)
    if (locked) assert.equal(calls.at(-1)[0], 'agent_configure', 'locked right after the launch')
  }
})

test('a314: the Owner\'s model change carries the key; a foreign lock is dropped by a relaunch that locks again', async () => {
  const lock = await lockFixture(), calls = []
  let foreign = false
  const project = await mkdtemp(join(tmpdir(), 'bellteam-lock-config-'))
  const client = { async call(name, args) {
    calls.push([name, args])
    if (name === 'agent_configure' && args.model && foreign) throw refusal()
    return name === 'agent_launch' ? { structuredContent: { session_id: 'bot-a' } } : {}
  } }
  const current = { id: 'bot-a', session: 'bot-a', harness: 'claude', project, model: 'opus', reasoningEffort: 'high', configurationLocked: true }
  const next = { ...current, model: 'sonnet' }
  const transport = new AitermTransport({ client, handoffContext: noMemory, configurationLock: lock, resolveBot: () => next })
  assert.equal((await transport.reconfigure(current, next)).mode, 'configure')
  assert.deepEqual(calls[0], ['agent_configure', { session_id: 'bot-a', model: 'sonnet', reasoning_effort: 'high', configuration_lock_key: await lock.key('bot-a') }])
  calls.length = 0; foreign = true
  assert.equal((await transport.reconfigure(current, { ...next, model: 'haiku' })).mode, 'restart')
  assert.deepEqual(calls.map(([name, args]) => name === 'agent_configure' && args.configuration_lock ? 'lock' : name),
    ['agent_configure', 'pty_close', 'agent_launch', 'lock'])
})

test('a314: the tracked configuration apply sends the key beside the request', async () => {
  const lock = await lockFixture(), sent = []
  const client = { async call(name, args) { sent.push([name, args]); throw new Error('stop here') } }
  const requests = new ConfigurationRequests({ client, intents: { async publish() {} }, lock })
  await assert.rejects(requests.apply('bot-a', 'bot-a', 'a'.repeat(32), { model: 'sonnet' }), /stop here/u)
  assert.equal(sent[0][0], 'agent_configure'); assert.equal(sent[0][1].action, 'apply')
  assert.equal(sent[0][1].configuration_lock_key, await lock.key('bot-a'))
})

test('a314: the Owner flipping the switch reaches a running seat; the save never depends on it', async () => {
  const bots = new Map([['bot-a', { id: 'bot-a', harness: 'claude', configurationLocked: false }]])
  bots.previewUpdate = async (id, changes) => ({ ...bots.get(id), ...changes })
  bots.update = async (id, changes) => { const next = { ...bots.get(id), ...changes }; bots.set(id, next); return next }
  const set = []
  let running = true, failing = false
  const tracked = []
  const admin = new BotAdministration({ bots, rooms: {}, writeLog() {}, trackCompletion: promise => tracked.push(promise), transport: {
    async isRunning() { return running }, async setConfigurationLock(bot, locked) { set.push(locked); if (failing) throw new Error('boom') } } })
  await admin.update('bot-a', { configurationLocked: true }); await Promise.all(tracked)
  await admin.update('bot-a', { configurationLocked: true }); await Promise.all(tracked)
  assert.deepEqual(set, [true], 'an unchanged switch sends nothing')
  failing = true
  assert.equal((await admin.update('bot-a', { configurationLocked: false })).bot.configurationLocked, false); await Promise.all(tracked)
  running = false
  await admin.update('bot-a', { configurationLocked: true }); await Promise.all(tracked)
  assert.deepEqual(set, [true, false], 'a seat that is not running gets nothing; the next launch locks it')
})
