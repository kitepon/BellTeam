import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as immediate } from 'node:timers/promises'
import test from 'node:test'
import { SecretRequests } from '../src/secret-requests.mjs'
import { OwnerQuestions } from '../src/owner-questions.mjs'
import { TimelineIndex } from '../src/timeline-index.mjs'
import { createOlrwAuthConsumer } from '../src/usage/olrw-auth-consumer.mjs'
import { attachOlrwOwnerQuestion } from '../src/olrw-management-caller.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

test('固定カード→usage→Owner HTTPページだけに公式guideを表示し内部/export/提出receiptへ出さない', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'olrw-owner-guide-http-'))
  const bots = new Map([['bot-synthetic', { id: 'bot-synthetic', name: 'synthetic' }]])
  const rooms = { refresh: async () => {}, get: () => ({ id: 'room-synthetic', name: 'room', memberIds: ['bot-synthetic'] }), messageView: () => new TimelineIndex() }
  const notifications = []
  const secrets = new SecretRequests({ root, bots, rooms, notify: async item => notifications.push(item) })
  const questions = new OwnerQuestions({ root, bots, notify: async () => {} })
  await secrets.initialize(); await questions.initialize()
  const question = await questions.create({ botId: 'bot-synthetic', question: 'synthetic start?', options: ['yes', 'no'], allowOther: false })
  const binding = { session_id: 'synthetic-auth', launch_id: 'synthetic-launch', metadata_identity: 'synthetic-metadata', native_id: '$10', pane_id: '%10', server_pid: 100, server_started: 's1', pane_pid: 101, pane_started: 'p1' }
  const url = 'https://claude.ai/oauth/authorize?synthetic=owner-guide-only'
  const result = stage => ({ structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: 'claude-code', session_id: binding.session_id,
    status: stage === 'complete' ? 'authenticated' : 'waiting', auth_ui: { schema: 'aiterm.auth-ui.v1', binding, stage,
      title: 'synthetic', message: '', url: stage === 'complete' ? null : url, user_code: null,
      input: stage === 'complete' ? null : 'authorization_code', prompt_digest: stage === 'complete' ? null : 'a'.repeat(64), choices: [] } } })
  const calls = []
  const auth = Object.fromEntries(['start', 'status', 'respond', 'cleanup'].map(action => [action, async () => {
    calls.push(action)
    return action === 'cleanup' ? { structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: 'claude-code', session_id: null, status: 'blocked' } }
      : result(action === 'respond' ? 'complete' : 'paste_code')
  }]))
  const context = { runId: 'synthetic-run', requesterBotId: 'bot-synthetic', toolId: 'olrw-auth', sessionId: binding.session_id,
    protectedHosted: 'protected-original', roomId: null, expiresAt: new Date(Date.now() + 60000).toISOString() }
  const caller = attachOlrwOwnerQuestion({ plan: { questionId: question.id, requesterBotId: question.botId, question: question.question, options: question.options, answer: 'yes' },
    ownerQuestions: questions, aiControl: { admit: () => () => {} }, assertAuthorized: async () => {},
    createConsumer: ({ assertAuthorized }) => createOlrwAuthConsumer({ secretRequests: secrets, runDirectory: join(root, 'state/olrw-auth'), context, assertAuthorized, auth }),
    reportFailure: () => assert.fail('unexpected caller failure') })
  let allowed = true
  const options = { bots, rooms, store: { timelineView: () => new TimelineIndex() }, secretRequests: secrets, ownerQuestions: questions,
    ownerSecretGuide: input => caller.ownerSecretGuide(input), authorize: async () => allowed, authMode: () => 'local', writeLog: () => {} }
  const publicServer = createBellTeamServer(options), internalServer = createBellTeamServer({ ...options, internal: true })
  for (const server of [publicServer, internalServer]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
  t.after(async () => { await caller.close(); for (const server of [publicServer, internalServer]) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${publicServer.address().port}`, internal = `http://127.0.0.1:${internalServer.address().port}`
  const page = async origin => (await (await fetch(origin + '/api/bots/bot-synthetic/messages')).json()).items
  await questions.answer(question.id, { choice: 'yes' })
  let request, visible
  for (let n = 0; n < 1000; n++) {
    request = [...secrets.items.values()][0]
    visible = (await page(base)).find(item => item.secret_request?.ownerGuide)
    if (visible) break
    await immediate()
  }
  assert.equal(visible?.secret_request.ownerGuide.url, url)
  assert.equal(JSON.stringify(await page(internal)).includes('owner-guide-only'), false)
  assert.equal(JSON.stringify(secrets.get(request.id)).includes('ownerGuide'), false)
  const exported = await (await fetch(base + '/api/bots/bot-synthetic/export')).text()
  assert.equal(exported.includes('owner-guide-only'), false)
  const internalRequest = await (await fetch(internal + '/api/secret-requests/' + request.id)).text()
  assert.equal(internalRequest.includes('owner-guide-only'), false)
  allowed = false
  assert.equal((await fetch(base + '/api/bots/bot-synthetic/messages')).status, 401)
  allowed = true
  const submitted = await fetch(base + `/api/secret-requests/${request.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'synthetic-code' }) })
  assert.equal(submitted.status, 200)
  assert.equal((await submitted.text()).includes('owner-guide-only'), false)
  assert.deepEqual(await caller.result, { runId: context.runId, outcome: 'confirmed', reason: 'authenticated_and_closed' })
  assert.deepEqual(calls, ['start', 'status', 'respond', 'cleanup'])
  assert.equal(JSON.stringify(await page(base)).includes('ownerGuide'), false)
  assert.equal(JSON.stringify(notifications).includes('owner-guide-only'), false)
  assert.equal((await readFile(join(root, 'state/secret-requests', request.id + '.json'), 'utf8')).includes('owner-guide-only'), false)
})
