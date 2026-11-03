import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AitermTransport, createManagedTransport } from '../src/aiterm-transport.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { BotScheduler } from '../src/scheduler.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('ordinary stop continues on the original managed session during members closure', async () => {
  const gate = new MembersAdmission(), calls = []
  const transport = createManagedTransport({ membersAdmission: gate, client: { async call(name, args) {
    calls.push([name, args])
    return { structuredContent: { status: 'sent', targets: [{ session_id: 'original', status: 'sent' }] } }
  } } })
  const ticket = gate.close()
  assert.equal((await transport.interrupt({ id: 'bot-synthetic', session: 'original' })).status, 'stop_sent')
  assert.deepEqual(calls, [['agent_stop', { session_id: 'original' }]])
  await gate.drain(ticket)
})
async function fixture(t, options = {}) {
  const project = await mkdtemp(join(tmpdir(), 'members-execution-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const bot = { id: 'bot-synthetic', session: 'synthetic', project, harness: 'codex', model: 'model', reasoningEffort: 'high', fastMode: false }
  const gate = new MembersAdmission('a'), calls = []
  const client = { async call(name) { calls.push(name); return { structuredContent: name === 'agent_launch' ? { session_id: bot.session, fast: false } : {} } }, async launchOptions() { return {} } }
  const transport = new AitermTransport({ membersAdmission: gate, client, handoffContext: async () => '', ...options })
  return { bot, gate, calls, transport }
}

test('wake retains one old lease through prepare, native and both persistence callbacks', async t => {
  const prepare = deferred(), saving = deferred(), prepared = deferred(), saved = deferred(), contexts = []
  const f = await fixture(t, {
    prepareStartup: async (bot, memory, context) => { contexts.push(context); prepared.resolve(); await prepare.promise },
    updateSession: async (id, session, context) => { contexts.push(context); saved.resolve(); await saving.promise },
    updateFastMode: async (id, value, context) => { contexts.push(context); assert.equal(value, false) },
  })
  const operation = f.transport.wake({ ...f.bot, fastMode: true })
  await prepared.promise
  const ticket = f.gate.close(); let drained = false
  const drain = f.gate.drain(ticket).then(() => { drained = true })
  assert.throws(() => f.transport.wake(f.bot), { code: 'MEMBERS_NOT_ACCEPTED' })
  prepare.resolve(); await saved.promise
  f.gate.assertLease(contexts[0].membersLease)
  assert.deepEqual(f.calls, ['agent_launch']); assert.equal(drained, false)
  saving.resolve(); await operation; await drain
  assert.equal(contexts.length, 3)
  assert.ok(contexts.every(context => context.membersLease === contexts[0].membersLease))
  assert.throws(() => f.gate.assertLease(contexts[0].membersLease), { code: 'MEMBERS_NOT_ACCEPTED' })
})

test('restart uses the same root across close and wake even with seven other roots', async t => {
  const closed = deferred(), closing = deferred(), f = await fixture(t)
  const others = Array.from({ length: 7 }, () => f.gate.enter())
  const original = f.transport.client.call
  f.transport.client.call = async name => {
    if (name === 'pty_close') { f.calls.push(name); closing.resolve(); await closed.promise; return {} }
    return original(name)
  }
  const restart = f.transport.restart(f.bot)
  await closing.promise
  const ticket = f.gate.close(); closed.resolve(); await restart
  assert.deepEqual(f.calls, ['pty_close', 'agent_launch'])
  others.forEach(lease => f.gate.finish(lease)); await f.gate.drain(ticket)
})

test('idle configure waits outside leases and rejects an exchange epoch before native input', async t => {
  const waiting = deferred(), f = await fixture(t)
  f.transport.idle = () => waiting.promise
  const configure = f.transport.reconfigure(f.bot, { ...f.bot, model: 'next' })
  await tick()
  const ticket = f.gate.close(); await f.gate.drain(ticket)
  f.gate.resume(ticket); waiting.resolve()
  await assert.rejects(configure, { code: 'MEMBERS_NOT_ACCEPTED' })
  assert.deepEqual(f.calls, [])
})

test('configure rechecks member and session certainty after idle before issuing', async t => {
  const entered = deferred(), validated = deferred()
  const f = await fixture(t, { requireMember: async () => { entered.resolve(); await validated.promise } })
  const configure = f.transport.reconfigure(f.bot, { ...f.bot, model: 'next' })
  await entered.promise
  f.transport.uncertainChanges.set(f.bot.id, 'agent_configure')
  validated.resolve()
  await assert.rejects(configure, { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.deepEqual(f.calls, [])
})

test('idle close drains while unrelated existing activity is retained', async t => {
  const issued = deferred(), closing = deferred(), f = await fixture(t)
  f.transport.activity.active.set('other', { bot: { id: 'other' }, completion: new Promise(() => {}) })
  f.transport.client.call = async name => { f.calls.push(name); issued.resolve(); await closing.promise; return {} }
  const close = f.transport.closeIdle(f.bot)
  await issued.promise
  const ticket = f.gate.close()
  closing.resolve(); assert.equal(await close, true); await f.gate.drain(ticket)
  assert.equal(f.transport.activity.active.has('other'), true)
})

test('session save failure remains uncertain after a module generation exchange', async t => {
  const original = Error('synthetic lost persistence reply')
  const f = await fixture(t, { updateSession: async () => { throw original } })
  await assert.rejects(f.transport.wake(f.bot), error => error === original)
  assert.equal(f.transport.uncertainChanges.get(f.bot.id), 'members_session_save')
  const ticket = f.gate.close(); await f.gate.drain(ticket); f.gate.adopt(ticket, 'b'); f.gate.resume(ticket)
  assert.throws(() => f.transport.wake(f.bot), { code: 'BOT_SESSION_UNCONFIRMED' })
  assert.deepEqual(f.calls, ['agent_launch'])
})

test('failed fresh member validation emits no native operation', async t => {
  const f = await fixture(t, { requireMember: async () => { throw Object.assign(Error('missing'), { status: 404 }) } })
  await assert.rejects(f.transport.wake(f.bot), { status: 404 })
  assert.deepEqual(f.calls, [])
})

test('command registration ends its root lease without waiting for the command to finish', async () => {
  const gate = new MembersAdmission(), command = deferred(), results = []
  const scheduler = new BotScheduler({ runCommand: () => command.promise, messenger: { async sendmessage(value) { results.push(value) } } })
  let completion
  await gate.withLease(() => { completion = scheduler.runCommandSchedule({ id: 'bot-synthetic', project: '/unused' }, { id: 'schedule', command: 'unused' }) })
  const ticket = gate.close(); await gate.drain(ticket)
  assert.equal(scheduler.commandJobs.size, 1)
  command.resolve({ code: 0, stdout: '', stderr: '' }); await completion
  assert.equal(scheduler.commandJobs.size, 0); assert.deepEqual(results, [])
})
