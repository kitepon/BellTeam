import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HarnessAuth } from '../src/harness-auth.mjs'
import { Onboarding } from '../src/onboarding.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { BotScheduler } from '../src/scheduler.mjs'

// Exercises the combined contracts at each resolved production conflict.
test('main integration: both authentication callers retain seat transport options and typed response refusal', async () => {
  const bots = new Map([['bot-a', { id: 'bot-a', harness: 'codex', project: '/synthetic-seat' }]])
  for (const onboarding of [false, true]) {
    const options = {}, calls = []
    const client = { authOptions: () => options, async call(...args) {
      calls.push(args)
      return { isError: true, structuredContent: { schema: 'aiterm.auth-response-error.v1',
        session_id: 'synthetic-session', effect: 'not_issued', code: 'FORM_MOVED' } }
    } }
    const auth = onboarding ? new Onboarding({ root: '/unused', bots, client }) : new HarnessAuth({ bots, client })
    if (onboarding) auth.state = { harness: 'codex', guideBotId: 'bot-a', authSession: 'synthetic-session' }
    else auth.sessions.set('codex', 'synthetic-session')
    await assert.rejects(onboarding ? auth.callAuth('respond', { response: { kind: 'text', text: 'synthetic' } })
      : auth.call('codex', 'respond', { response: { kind: 'text', text: 'synthetic' } }),
    e => e.code === 'AUTH_RESPONSE_NOT_ISSUED' && e.effect === 'not_issued')
    assert.equal(calls[0][2], options)
    assert.equal(Object.hasOwn(calls[0][2], 'env'), false)
    assert.equal(calls[0][1].cwd, '/synthetic-seat')
  }
})

test('main integration: an in-flight schedule completion preserves a private-state future revision and seat files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'main-private-revision-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const botsRoot = join(root, 'seats'), stateRoot = join(root, 'private'), seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [{ id: 'bot-a', displayName: 'A', harness: 'grok', session: 'bot-a', project: join(botsRoot, 'bot-a') }] }))
  const bots = new BotRegistry({ seedPath, botsRoot, stateRoot, id: () => 'once-id' })
  await bots.initialize()
  await mkdir(join(botsRoot, 'bot-a'), { recursive: true })
  const seatSchedule = join(botsRoot, 'bot-a/schedule.json')
  await writeFile(seatSchedule, 'seat sentinel untouched')
  await bots.setSchedule('bot-a', { kind: 'once', at: '2026-10-25T11:25:00Z', prompt: 'old' })
  let entered, finish
  const started = new Promise(resolve => { entered = resolve }), delivery = new Promise(resolve => { finish = resolve })
  const scheduler = new BotScheduler({ registry: bots, messenger: { async sendmessage() { entered(); await delivery } } })
  const running = scheduler.runDue(new Date('2026-10-25T11:25:01Z'))
  await started
  const future = await bots.setSchedule('bot-a', { id: 'once-id', kind: 'once', at: '2026-10-25T11:45:00Z', prompt: 'new' })
  finish(); await running
  assert.deepEqual((await bots.listSchedules('bot-a'))[0], future)
  assert.equal(future.enabled, true)
  assert.equal(await readFile(seatSchedule, 'utf8'), 'seat sentinel untouched')
  assert.equal(JSON.parse(await readFile(join(stateRoot, 'bot-a/schedule.json'), 'utf8')).schedules[0].prompt, 'new')
})
