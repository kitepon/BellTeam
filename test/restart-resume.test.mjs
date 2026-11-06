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

test('cold startup resumes saved active conversations only, never fresh, and asks once for the known gap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'restart-resume-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'execution-activity.json'), now = '2026-11-06T06:00:00.000Z'
  const activity = new CurrentWork({ activityPath: path, now: () => now })
  for (const id of ['active','unavailable','idle','missing']) {
    const entry = activity.startedActivity(id, 'codex-cli', id, { session_id: id, launch_id: 'a'.repeat(32) })
    if (id === 'idle') activity.finishedActivity(id, entry)
  }
  await activity.activityQueue
  const bots = new Map(['active','unavailable','idle','no-reference'].map(id => [id, { id, session: id, harness: 'codex', project: root }]))
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
  assert.equal(summaries.length, 1); assert.equal(summaries[0].botId, 'active'); assert.equal(summaries[0].from, now)
  assert.equal(reports.some(value => value.code === 'RESTART_RESUME_UNAVAILABLE'), true)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).targets, [])
  await start('second')
  assert.equal(launches.length, 2); assert.equal(summaries.length, 1)

  const client = new AitermClient()
  let nativeCalls = 0
  client.client = { listTools: async () => ({ tools: [{ name: 'agent_launch', inputSchema: { properties: {} } }] }), callTool: async () => { nativeCalls++ } }
  await assert.rejects(client.call('agent_launch', { session_name: 'active', require_existing_resume: true }), { code: 'RESUME_CAPABILITY_UNAVAILABLE' })
  assert.equal(nativeCalls, 0)
  client.client.listTools = async () => ({ tools: [{ name: 'agent_launch', inputSchema: { properties: { require_existing_resume: { type: 'boolean' } } } }] })
  client.client.callTool = async () => ({ isError: true, content: [], _meta: { 'aiterm/resume_unavailable': {
    schema: 'aiterm.agent-resume-unavailable.v1', code: 'AGENT_RESUME_UNAVAILABLE', session_id: 'active', outcome: 'unavailable', effect: 'not_started', input: 'not_sent' } } })
  await assert.rejects(client.call('agent_launch', { session_name: 'active', require_existing_resume: true }), error => error.resumeUnavailable?.input === 'not_sent' && error.code === 'AGENT_RESUME_UNAVAILABLE')
})
