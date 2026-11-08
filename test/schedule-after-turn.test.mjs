import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BotRegistry } from '../src/bot-registry.mjs'
import { BotScheduler } from '../src/scheduler.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'
import { createMembersDispatcher } from '../src/members/dispatcher.mjs'
import { validateMembersResult } from '../src/members/protocol.mjs'
import { createScheduleApi } from '../src/members/schedules-http.mjs'
import { botScheduleTools } from '../src/members/schedules-mcp.mjs'

// One end-to-end schedules contract: real writer + child DTO/effect + event-driven scheduler.
test('after_turn binds its owner, reconciles races and consumes once through ordinary delivery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'schedule-after-turn-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [
    { id: 'bot-a', displayName: 'Synthetic', harness: 'grok', session: 'bot-a', project: '/unused' },
  ] }))
  await mkdir(join(root, 'state'))
  let current = { state: 'working', turnId: 'turn-1' }, listener
  const transport = { currentTurn: () => current, watchTurn: callback => { listener = callback; return () => { listener = null } } }
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots'), stateRoot: join(root, 'state/bots'), currentTurn: transport.currentTurn })
  await bots.initialize()
  await new OwnerProfile({ root }).initialize(); await new UserRules({ root }).initialize()
  const context = { generation: 'test', leaseId: 'lease', rootId: 'root', ownerWrite: false, continuation: false }
  const child = createMembersDispatcher({ root, effect: async (method, params) => {
    assert.equal(method, 'schedules.currentTurn'); assert.equal(params.botId, 'bot-a'); return { ...current }
  }, projection: async record => { if (record.type === 'snapshot-end') bots.changed('bot-a', 'schedules') } })
  await child.control('initialize', { generation: 'test' }, { ...context, leaseId: null })
  await child.control('resume', {})
  const request = (method, params) => child.dispatch(method, params, context)
  const owner = { ownerKind: 'bot', ownerId: 'bot-a' }
  const sent = []
  const scheduler = new BotScheduler({ registry: bots, transport, completedTurns: async () => 0,
    messenger: { sendmessage: async message => {
      assert.equal((await bots.listSchedules('bot-a')).find(item => message.message.includes(item.id)).enabled, false)
      sent.push(message)
    } }, intervalMs: 1_000_000 })
  scheduler.start(); t.after(() => scheduler.stop())
  const settle = () => scheduler.requestAfterTurn()
  const event = async value => { current = value; listener({ botId: 'bot-a', ...value }); await scheduler.afterTurnRun }
  const create = async input => (await request('schedules.set', { ...owner, input: { kind: 'after_turn', prompt: 'continue', ...input } })).schedule
  const first = await create()
  validateMembersResult('schedules.set', { schedule: first })
  assert.equal(first.afterTurn.turnId, 'turn-1'); assert.equal(first.state, 'waiting-for-turn-end'); assert.equal(first.nextRunAt, null)
  await settle(); assert.equal(sent.length, 0)
  // Normal, error and stop all have the same public working -> idle event.
  await event({ state: 'idle', turnId: null }); assert.equal(sent.length, 1)
  await event({ state: 'idle', turnId: null }); assert.equal(sent.length, 1)
  assert.equal((await bots.listSchedules('bot-a'))[0].state, 'completed')
  const immediate = await create(); await settle(); assert.equal(sent.length, 2)
  assert.equal(sent[1].target, 'bot-a'); assert.ok(sent[1].message.includes(immediate.id))
  current = { state: 'working', turnId: 'turn-2' }
  const replaced = await create()
  const replacement = await create({ id: replaced.id, prompt: 'replacement' })
  await request('schedules.remove', { ...owner, scheduleId: replacement.id })
  await event({ state: 'idle', turnId: null }); assert.equal(sent.length, 2)
  // Unknown never means idle; resolution binds a working identity, then its end delivers.
  current = { state: 'unknown', turnId: null }
  const unknown = await create(); await settle(); assert.equal(sent.length, 2)
  await event({ state: 'working', turnId: 'turn-3' }); assert.equal(sent.length, 2)
  assert.equal((await bots.listSchedules('bot-a')).find(item => item.id === unknown.id).afterTurn.turnId, 'turn-3')
  await event({ state: 'idle', turnId: null }); assert.equal(sent.length, 3)
  // The owning turn can end while its captured snapshot is being returned to the child.
  current = { state: 'working', turnId: 'turn-4' }
  const capture = bots.currentTurn
  bots.currentTurn = () => {
    const captured = current; current = { state: 'idle', turnId: null }; return captured
  }
  const raced = await bots.setSchedule('bot-a', { kind: 'after_turn', prompt: 'race' })
  bots.currentTurn = capture
  await settle(); assert.equal(sent.length, 4); assert.ok(sent[3].message.includes(raced.id))
  // A replaced revision cannot be claimed by an event holding an older schedule snapshot.
  current = { state: 'working', turnId: 'turn-5' }
  const stale = await create(), latest = await create({ id: stale.id, prompt: 'latest' })
  const claim = { botId: 'bot-a', scheduleId: stale.id, expectedRevision: stale.revision, expectedAfterTurn: stale.afterTurn,
    observedTurn: { state: 'idle', turnId: null }, ranAt: new Date().toISOString() }
  assert.equal(await request('schedules.claimAfterTurn', claim), null)
  current = { state: 'idle', turnId: null }
  const grants = await Promise.all([1, 2].map(() => request('schedules.claimAfterTurn', { ...claim, expectedRevision: latest.revision })))
  assert.equal(grants.filter(Boolean).length, 1)
  const beforeUnknown = sent.length
  current = { state: 'unknown', turnId: null }
  await create(); await scheduler.afterTurnRun
  assert.equal(sent.length, beforeUnknown)
  await event({ state: 'idle', turnId: null }); assert.equal(sent.length, beforeUnknown + 1)
  const disabled = await create({ enabled: false }); await scheduler.afterTurnRun
  assert.equal((await bots.listSchedules('bot-a')).find(item => item.id === disabled.id).state, 'disabled')
  assert.equal(sent.length, beforeUnknown + 1)
  for (const input of [{ command: 'true', prompt: undefined }, { at: new Date().toISOString() }, { timezone: 'UTC' }, { afterTurn: current }])
    await assert.rejects(create(input))
  // Released Apple/Web editors submit fallback cron; preserve the stored continuation.
  current = { state: 'working', turnId: 'turn-edit' }
  const protectedSchedule = await create()
  const api = createScheduleApi({ bots, rooms: null, scheduler })
  for (const expression of ['0 9 * * 1-5', '']) {
    let status, body
    const response = { writeHead: code => { status = code }, end: value => { body = JSON.parse(value) } }
    const request = { method: 'PUT', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ kind: 'cron', expression, prompt: 'edited' })) } }
    await api(request, response, new URL(`http://test/api/bots/bot-a/schedules/${protectedSchedule.id}`))
    assert.equal(status, 409); assert.equal(body.error, 'SCHEDULE_AFTER_TURN_REPLACE_REQUIRED')
    assert.deepEqual((await bots.listSchedules('bot-a')).find(item => item.id === protectedSchedule.id), protectedSchedule)
  }
  await assert.rejects(create({ id: protectedSchedule.id, kind: 'cron', expression: '0 9 * * 1-5' }), { code: 'SCHEDULE_AFTER_TURN_REPLACE_REQUIRED' })
  await create({ id: protectedSchedule.id, prompt: 'still after turn' })
  const tool = botScheduleTools.find(tool => tool.name === 'set_schedule')
  assert.ok(tool.inputSchema.properties.kind.enum.includes('after_turn'))
})
