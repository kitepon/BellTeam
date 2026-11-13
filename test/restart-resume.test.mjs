import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CurrentWork } from '../src/current-work.mjs'
import { createExecutionDispatcher } from '../src/execution-dispatcher.mjs'
import { createExecutionAssembly } from '../src/execution-assembly.mjs'
import { MembersAdmission } from '../src/members-admission.mjs'
import { AitermClient } from '../src/aiterm-client.mjs'

test('cold startup resumes saved active conversations with resume-only launches, asks once for the known gap, and a refused resume gets one fresh continuation delivery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'restart-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'execution-activity.json'), now = '2026-11-06T06:00:00.000Z'
  const activity = new CurrentWork({ activityPath: path, now: () => now })
  for (const id of ['active','unavailable','idle','missing']) {
    const entry = activity.startedActivity(id, 'codex-cli', id, { session_id: id, launch_id: 'a'.repeat(32) })
    if (id === 'idle') activity.finishedActivity(id, entry)
  }
  // A working seat on a harness without resume support is woken fresh, not silently left down.
  activity.startedActivity('grok', 'grok-cli', 'grok', { session_id: 'grok', launch_id: 'a'.repeat(32) })
  await activity.activityQueue
  const bots = new Map(['active','unavailable','idle','no-reference'].map(id => [id, { id, session: id, harness: 'codex', project: root }]))
  bots.set('grok', { id: 'grok', session: 'grok', harness: 'grok', project: root })
  bots.refresh = async () => {}
  const launches = [], summaries = [], reports = []
  const ports = { native: { launchOptions: async () => ({}), async call(name, args) {
    if (name === 'pty_list') return { content: [] }
    if (name === 'agent_launch') {
      launches.push(args)
      assert.equal(args.require_existing_resume, true)
      assert.equal(Object.hasOwn(args, 'prompt'), false)
      assert.equal(Object.hasOwn(args, 'model'), false)
      if (args.session_name === 'unavailable') throw Object.assign(Error('unavailable'), { code: 'AGENT_RESUME_UNAVAILABLE', effect: 'not_started' })
      return { structuredContent: { schema: 'aiterm.agent-launch-result.v1', session_id: args.session_name,
        startup: { status: 'ready' }, initial_prompt: { status: 'not_requested' } } }
    }
    assert.fail('unexpected native action: ' + name)
  } }, bots, rooms: {}, membersAdmission: new MembersAdmission(), configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() },
    access: { assertWorkAllowed() {} }, storage: {}, diagnostics: { record: report => reports.push(report) }, observer: { report() {} } }
  const start = async generation => {
    const assembly = createExecutionAssembly({ ports, requestRestartSummary: async input => summaries.push(input),
      loadFactory: async () => Object.freeze({ versionId: null, sourceCommit: 'a'.repeat(40), createExecutionDispatcher }),
      onAdopt: async () => {}, requestStop: async () => {}, watchQueue: () => () => {} })
    await assembly.controller.start()
    await assembly.controller.close()
  }
  await start('first')
  assert.deepEqual(launches.map(value => value.session_name).sort(), ['active','unavailable'])
  const byBot = Object.fromEntries(summaries.map(value => [value.botId, value]))
  assert.equal(summaries.length, 3); assert.equal(byBot.active.from, now); assert.equal(byBot.active.resumed, undefined)
  assert.equal(byBot.grok.resumed, false)
  // Owner 2026-11-08: the refused seat is not left down; one ordinary delivery wakes it fresh (restart-resume.md).
  assert.equal(byBot.unavailable.resumed, false); assert.equal(byBot.unavailable.from, now)
  assert.equal(reports.some(value => value.code === 'SERVER_TURN_TRACKING_FAILED' && JSON.parse(value.diagnostic_log).code === 'RESTART_RESUME_UNAVAILABLE'), false)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).targets, [])
  await start('second')
  assert.equal(launches.length, 2); assert.equal(summaries.length, 3)

  const client = new AitermClient()
  let nativeCalls = 0
  client.client = { request: async () => ({ tools: [{ name: 'agent_launch', inputSchema: { properties: {} } }] }), callTool: async () => { nativeCalls++ } }
  await assert.rejects(client.call('agent_launch', { session_name: 'active', require_existing_resume: true }), { code: 'RESUME_CAPABILITY_UNAVAILABLE' })
  assert.equal(nativeCalls, 0)
  client.client.request = async () => ({ tools: [{ name: 'agent_launch', inputSchema: { properties: { require_existing_resume: { type: 'boolean' } } } }] })
  client.client.callTool = async () => ({ isError: true, content: [], _meta: { 'aiterm/resume_unavailable': {
    schema: 'aiterm.agent-resume-unavailable.v1', code: 'AGENT_RESUME_UNAVAILABLE', session_id: 'active', outcome: 'unavailable', effect: 'not_started', input: 'not_sent' } } })
  await assert.rejects(client.call('agent_launch', { session_name: 'active', require_existing_resume: true }), error => error.resumeUnavailable?.input === 'not_sent' && error.code === 'AGENT_RESUME_UNAVAILABLE')
})


test('cold resume rejection reaches the existing registered diagnostics sink without exception text', async t => {
  const { Diagnostics } = await import('../src/diagnostics.mjs')
  const root = await mkdtemp(join(tmpdir(), 'restart-diagnostic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const activity = new CurrentWork({ activityPath: join(root, 'execution-activity.json') })
  activity.startedActivity('bot-active', 'codex-cli', 'bot-active', { session_id: 'bot-active', launch_id: 'a'.repeat(32) })
  await activity.activityQueue
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json')); await diagnostics.initialize()
  const bots = new Map([['bot-active', { id: 'bot-active', session: 'bot-active', harness: 'codex', project: root }]])
  let called = false
  const dispatcher = createExecutionDispatcher({ generation: 'one', ports: {
    native: { launchOptions: async () => ({}), call: async (tool, args) => {
      if (tool === 'pty_list') return { content: [] }
      assert.equal(tool, 'agent_launch'); assert.equal(args.require_existing_resume, true); called = true
      throw Object.assign(Error('PRIVATE_BODY_STACK'), { code: 'AGENT_RESUME_UNAVAILABLE' })
    } }, bots, rooms: {}, membersAdmission: new MembersAdmission(),
    configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() },
    access: { assertWorkAllowed() {} }, diagnostics: { record: report => diagnostics.record(report) }, observer: { report() {} },
  } })
  t.after(async () => { await dispatcher.control('quiesce'); await dispatcher.control('exit') })
  await dispatcher.control('initialize')
  for (let i = 0; i < 100 && !(await diagnostics.list()).length; i++) await new Promise(resolve => setTimeout(resolve, 1))
  const rows = await diagnostics.list(); assert.equal(called, true); assert.equal(rows.length, 1)
  assert.deepEqual(JSON.parse(rows[0].diagnostic_log), { stage: 'restart_resume', code: 'RESTART_RESUME_UNAVAILABLE',
    botId: 'bot-active', sessionId: 'bot-active', cause_code: 'AGENT_RESUME_UNAVAILABLE' })
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_BODY_STACK'))
})

for (const sendFails of [false, true]) test(`refused resume asks for one fresh continuation delivery (send fails: ${sendFails})`, async t => {
  const { Diagnostics } = await import('../src/diagnostics.mjs')
  const root = await mkdtemp(join(tmpdir(), 'restart-fresh-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const activity = new CurrentWork({ activityPath: join(root, 'execution-activity.json') })
  activity.startedActivity('bot-active', 'codex-cli', 'bot-active', { session_id: 'bot-active', launch_id: 'a'.repeat(32) })
  await activity.activityQueue
  const diagnostics = new Diagnostics(join(root, 'diagnostics.json')); await diagnostics.initialize()
  const bots = new Map([['bot-active', { id: 'bot-active', session: 'bot-active', harness: 'codex', project: root }]])
  const requests = []
  const dispatcher = createExecutionDispatcher({ generation: 'one', requestRestartSummary: async input => {
    requests.push(input); if (sendFails) throw new Error('send failed')
  }, ports: {
    native: { launchOptions: async () => ({}), call: async tool => {
      if (tool === 'pty_list') return { content: [] }
      throw Object.assign(Error('PRIVATE_BODY_STACK'), { code: 'AGENT_RESUME_UNAVAILABLE' })
    } }, bots, rooms: {}, membersAdmission: new MembersAdmission(),
    configurationStorage: { root: join(root, 'intents'), ownerUid: process.getuid() },
    access: { assertWorkAllowed() {} }, diagnostics: { record: report => diagnostics.record(report) }, observer: { report() {} },
  } })
  t.after(async () => { await dispatcher.control('quiesce'); await dispatcher.control('exit') })
  await dispatcher.control('initialize')
  for (let i = 0; i < 100 && !requests.length; i++) await new Promise(resolve => setTimeout(resolve, 1))
  for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].botId, 'bot-active'); assert.equal(requests[0].resumed, false)
  assert.ok(Date.parse(requests[0].from) < Date.parse(requests[0].to))
  const rows = await diagnostics.list()
  if (!sendFails) assert.equal(rows.length, 0)
  else assert.equal(JSON.parse(rows[0].diagnostic_log).continuation, 'failed')
})
