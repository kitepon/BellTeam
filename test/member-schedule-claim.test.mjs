import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BotRegistry } from '../src/bot-registry.mjs'

const now = new Date('2030-01-01T00:00:01Z')
async function fixture(t, kind = 'once') {
  const root = await mkdtemp(join(tmpdir(), 'members-claim-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: 'Synthetic', harness: 'grok', session: 'bot-a', project: '/unused' }] }))
  const options = { seedPath, botsRoot: join(root, 'projects'), stateRoot: join(root, 'state'), now: () => new Date('2029-12-31T23:59:00Z') }
  const bots = new BotRegistry(options); await bots.initialize()
  const input = kind === 'once' ? { at: '2030-01-01T00:00:00Z' } : { expression: '* * * * *', timezone: 'UTC' }
  const schedule = await bots.setSchedule('bot-a', { ...input, kind, prompt: 'Synthetic' })
  const claim = { botId: 'bot-a', scheduleId: schedule.id, expectedRevision: schedule.revision, expectedNextRunAt: schedule.nextRunAt, ranAt: now }
  return { bots, schedule, claim, options }
}

test('same tuple can be consumed once and cannot be reconstructed after restore', async t => {
  const f = await fixture(t)
  const results = await Promise.all([f.bots.claimDue(f.claim), f.bots.claimDue(f.claim)])
  assert.deepEqual(results, [f.schedule, null])
  const [saved] = await f.bots.listSchedules('bot-a')
  assert.equal(saved.enabled, false); assert.equal(saved.lastRunAt, now.toISOString())
  assert.equal(saved.revision, f.schedule.revision)
  const restored = new BotRegistry(f.options); await restored.restore()
  assert.equal(await restored.claimDue(f.claim), null)
})

test('new revision, future evaluation, stale nextRunAt and invalid time do not consume', async t => {
  const f = await fixture(t)
  assert.equal(await f.bots.claimDue({ ...f.claim, ranAt: '2029-12-31T23:59:59Z' }), null)
  assert.equal(await f.bots.claimDue({ ...f.claim, expectedNextRunAt: '2029-12-31T00:00:00Z' }), null)
  await assert.rejects(f.bots.claimDue({ ...f.claim, ranAt: 'invalid' }), { code: 'SCHEDULE_CLAIM_INVALID' })
  const latest = await f.bots.setSchedule('bot-a', { ...f.schedule, prompt: 'latest' })
  assert.equal(await f.bots.claimDue(f.claim), null)
  assert.deepEqual((await f.bots.listSchedules('bot-a'))[0], latest)
})

test('skip preserves lastRunAt and cron consumption advances the same tuple', async t => {
  const f = await fixture(t, 'cron')
  assert.deepEqual(await f.bots.skipDue(f.claim), f.schedule)
  const [saved] = await f.bots.listSchedules('bot-a')
  assert.equal(saved.lastRunAt, f.schedule.lastRunAt)
  assert.equal(saved.nextRunAt, '2030-01-01T00:01:00.000Z')
  assert.equal(await f.bots.claimDue(f.claim), null)
})

test('failed claim persistence grants nothing and releases mutation order', async t => {
  const f = await fixture(t), write = f.bots.writeScheduleDocument.bind(f.bots)
  f.bots.writeScheduleDocument = async () => { throw new Error('synthetic write failure') }
  await assert.rejects(f.bots.claimDue(f.claim), /synthetic write failure/)
  assert.deepEqual((await f.bots.listSchedules('bot-a'))[0], f.schedule)
  f.bots.writeScheduleDocument = write
  assert.deepEqual(await f.bots.claimDue(f.claim), f.schedule)
})

test('retirement and stale schedule reads cannot recreate a Bot state directory', async t => {
  const f = await fixture(t)
  await f.bots.remove('bot-a')
  assert.equal(await f.bots.claimDue(f.claim), null)
  assert.deepEqual(await f.bots.readScheduleDocument('bot-a'), { schema: 'bellteam.schedule.v1', schedules: [] })
  await assert.rejects(stat(join(f.options.stateRoot, 'bot-a')), { code: 'ENOENT' })
})
