import assert from 'node:assert/strict'
import { AitermClient } from '../src/aiterm-client.mjs'
import { authTool } from './helpers/auth-capability.mjs'
import { createOlrwRabbitAuth } from '../src/olrw-rabbit-auth.mjs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { prepareOlrwManagement, readOlrwManagedFile, OLRW_MANAGEMENT_PATHS as paths } from '../src/olrw-management-loader.mjs'
import { attachOlrwOwnerQuestion } from '../src/olrw-management-caller.mjs'
import { OwnerQuestions } from '../src/owner-questions.mjs'
import { SecretRequests } from '../src/secret-requests.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
async function until(predicate) {
  for (let n = 0; n < 500; n++) { if (await predicate()) return; await delay(2) }
  assert.fail('synthetic boundary not reached')
}
async function fixture(t, { answered = false, expiry = 60000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'olrw-loader-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bots = new Map([['bot-synthetic', { name: 'synthetic' }]])
  const questions = new OwnerQuestions({ root, bots, notify: async () => {} })
  const secrets = new SecretRequests({ root, bots, notify: async () => {} })
  await questions.initialize(); await secrets.initialize()
  const question = await questions.create({ botId: 'bot-synthetic', question: 'synthetic start?', options: ['yes', 'no'], allowOther: false })
  if (answered) await questions.answer(question.id, { choice: 'yes' })
  const decision = { decision_id: 'K-ABC123', version: 3, requester: 'synthetic', status: 'answered', context: 'synthetic fixed profile and initializer permission',
    options: [{ id: 'allow', label: 'synthetic' }], answer: { option_id: 'allow', answered_at: new Date().toISOString() } }
  const document = { schema: 'bellteam.olrw-auth.management.v1',
    context: { runId: 'synthetic-run', sessionId: 'synthetic-auth', protectedHosted: 'protected-hosted', requesterBotId: question.botId, roomId: null, toolId: 'olrw-auth', expiresAt: new Date(Date.now() + expiry).toISOString() },
    question: { questionId: question.id, requesterBotId: question.botId, question: question.question, options: question.options, answer: 'yes' },
    target: { nodePath: '/approved/node', entryPath: '/approved/aiterm/dist/index.js', version: '99.1.2', profileSha256: 'c'.repeat(64) },
    approval: { decisionId: decision.decision_id, version: decision.version, requester: decision.requester, connectionId: 'connection', userId: 'owner', optionId: 'allow', contextSha256: hash(decision.context), optionsSha256: hash(JSON.stringify(decision.options)) } }
  const records = new Map([[paths.plan, Buffer.from(JSON.stringify(document))], [paths.token, Buffer.from('synthetic-token\n')]])
  const current = { parentPid: 100, parentStarted: 'birth1', sshPid: 101, sshStarted: 'birth2' }
  const counts = { initialize: 0, close: 0, get: 0, auth: 0, token: 0 }
  let epoch = 0, prepared, caller, mutateInitialize = () => {}, prepareFailure = false
  const aiControl = { admit: () => { const original = epoch; return () => { if (epoch !== original) throw new Error('stopped') } } }
  const runDirectory = join(root, 'state/olrw-auth')
  const options = { root, ownerQuestions: questions, aiControl,
    // Positive root ownership/Box/SSH are modeled. Only journals and existing cards use real local files.
    readManaged: async path => { if (path === paths.token) counts.token++; if (!records.has(path)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return records.get(path) },
    makeAuth: ({ assertBeforeIssue }) => ({
      prepare: async () => {
        counts.initialize++
        const journal = (await readFile(join(runDirectory, 'synthetic-run.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).at(-1)
        assert.equal(journal.intent, 'start'); assert.equal(journal.counts.start, 1)
        assert.equal(await readFile(join(runDirectory, 'session-synthetic-auth.reserved'), 'utf8'), 'synthetic-run')
        if (prepareFailure) throw new Error('init failure')
        return {}
      },
      start: async () => { assertBeforeIssue(); counts.auth++; return { structuredContent: {
        schema: 'aiterm.agent-auth-result.v1', harness: 'claude-code', session_id: 'synthetic-auth', status: 'authenticated',
        auth_ui: { schema: 'aiterm.auth-ui.v1', binding: { session_id: 'synthetic-auth', launch_id: 'l', metadata_identity: 'm', native_id: '$10', pane_id: '%10', server_pid: 100, server_started: 's', pane_pid: 101, pane_started: 'p' },
          stage: 'complete', title: 'synthetic', message: '', url: null, user_code: null, input: null, prompt_digest: null, choices: [] } } } },
      cleanup: async () => { assertBeforeIssue(); counts.auth++; return { structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: 'claude-code', session_id: null, status: 'blocked' } } },
      status: async () => assert.fail('status not expected'), respond: async () => assert.fail('respond not expected'),
      close: async () => { counts.close++ },
    }),
    metadata: async () => ({ ...current }), fetchImpl: async url => {
      counts.get++
      if (!url.endsWith('/connection') && counts.get === 8) await mutateInitialize()
      return Response.json(url.endsWith('/connection') ? { connection_id: 'connection', me: { user_id: 'owner' } } : decision)
    } }
  const start = async () => {
    prepared = await prepareOlrwManagement(options)
    assert.equal(counts.initialize, 0); assert.equal(counts.get, 0)
    caller = attachOlrwOwnerQuestion({ ...prepared, plan: prepared.plan, ownerQuestions: questions, aiControl,
      createConsumer: ({ assertAuthorized }) => {
        const consumer = prepared.createConsumer({ secretRequests: secrets, runDirectory, context: prepared.context, assertAuthorized, auth: prepared.auth })
        return { ...consumer, execute: async opts => { try { return await consumer.execute(opts) } finally { await prepared.auth.close() } },
          close: async () => { consumer.close(); await prepared.auth.close() } }
      }, reportFailure: () => {} })
    t.after(() => caller.close())
    await questions.answer(question.id, { choice: 'yes' })
    return caller
  }
  const evidence = () => records.set(paths.evidence, Buffer.from(JSON.stringify({ schema: 'bellteam.olrw-auth.target-evidence.v1', runId: document.context.runId, profileSha256: document.target.profileSha256, ...current })))
  return { root, options, records, document, counts, current, start, evidence, secrets,
    stop: () => { epoch++ }, mutate: fn => { mutateInitialize = fn }, failPrepare: () => { prepareFailure = true } }
}

test('既回答/plan不在はtoken・原本・MCPを触らず可変祖先fileを拒否する', async t => {
  const f = await fixture(t, { answered: true })
  assert.equal((await prepareOlrwManagement(f.options)).auth, null)
  assert.deepEqual(f.counts, { initialize: 0, close: 0, get: 0, auth: 0, token: 0 })
  f.records.delete(paths.plan)
  assert.equal(await prepareOlrwManagement(f.options), null)
  const path = join(f.root, 'untrusted'); await writeFile(path, 'synthetic', { mode: 0o440 })
  await assert.rejects(readOlrwManagedFile(path, 100), /OLRW_MANAGEMENT_UNAVAILABLE/)
})

test('Owner回答→永続予約/start intent→initialize→同接続証拠→auth、再起動で再prepareしない', async t => {
  const f = await fixture(t), caller = await f.start()
  await until(() => f.counts.initialize === 1)
  assert.equal(f.counts.auth, 0)
  const preflight = join(f.root, 'logs/olrw-client-preflight.json')
  await until(async () => { try { return JSON.parse(await readFile(preflight)).sshPid === f.current.sshPid } catch { return false } })
  f.evidence()
  assert.equal((await caller.result).outcome, 'confirmed')
  assert.equal(f.counts.auth, 2); assert.equal(f.counts.initialize, 1)
  assert.equal((await prepareOlrwManagement(f.options)).auth, null)
  assert.equal(f.counts.initialize, 1)
})

for (const kind of ['remove', 'replace', 'expire', 'epoch']) test(`実新経路のinitialize原本GET中${kind}でprepare0/auth0`, async t => {
  const f = await fixture(t, { expiry: kind === 'expire' ? 150 : 60000 })
  f.mutate(async () => {
    if (kind === 'remove') f.records.delete(paths.plan)
    if (kind === 'replace') f.records.set(paths.plan, Buffer.from(JSON.stringify({ ...f.document, target: { ...f.document.target, version: '99.1.3' } })))
    if (kind === 'expire') await delay(180)
    if (kind === 'epoch') f.stop()
  })
  const caller = await f.start()
  assert.notEqual((await caller.result).outcome, 'confirmed')
  assert.equal(f.counts.get, 8, 'mutation must occur during initialize GET, after usage claim/intent')
  assert.equal(f.counts.initialize, 0); assert.equal(f.counts.auth, 0)
  const journal = await readFile(join(f.root, 'state/olrw-auth/synthetic-run.jsonl'), 'utf8')
  assert.match(journal, /"intent":"start"/)
})

for (const kind of ['expire', 'close', 'epoch']) test(`証拠待ち中${kind}後に正常証拠が遅着してもauth0/reprepare0`, async t => {
  const f = await fixture(t, { expiry: kind === 'expire' ? 250 : 60000 }), caller = await f.start()
  await until(() => f.counts.initialize === 1)
  if (kind === 'expire') await delay(300)
  if (kind === 'close') await caller.close()
  if (kind === 'epoch') f.stop()
  f.evidence()
  assert.notEqual((await caller.result).outcome, 'confirmed')
  await delay(120)
  assert.equal(f.counts.initialize, 1); assert.equal(f.counts.auth, 0)
  assert.equal(f.counts.close, 1)
})

test('初期化unknownを回収し同runの再executeではprepare0', async t => {
  const f = await fixture(t); f.failPrepare()
  const caller = await f.start()
  assert.equal((await caller.result).outcome, 'unknown')
  assert.equal(f.counts.initialize, 1); assert.equal(f.counts.auth, 0); assert.equal(f.counts.close, 1)
})

for (const boundary of ['input', 'run', 'close']) test(`SDK deadline: usage ${boundary} gate crosses awaited prepare with zero respond RPC`, async t => {
  const realNow = Date.now.bind(Date); let offset = 0
  t.mock.method(Date, 'now', () => realNow() + offset)
  const f = await fixture(t, { expiry: 1200000 }), issued = []
  const binding = { session_id: 'synthetic-auth', launch_id: 'l', metadata_identity: 'm', native_id: '$10', pane_id: '%10', server_pid: 100, server_started: 's', pane_pid: 101, pane_started: 'p' }
  const result = complete => ({ structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: 'claude-code', session_id: binding.session_id,
    status: complete ? 'authenticated' : 'waiting', auth_ui: { schema: 'aiterm.auth-ui.v1', binding, stage: complete ? 'complete' : 'paste_code', title: 'synthetic', message: '',
      url: complete ? null : 'https://claude.ai/oauth/authorize?synthetic=only', user_code: null, input: complete ? null : 'authorization_code', prompt_digest: complete ? null : 'a'.repeat(64), choices: [] } } })
  let caller
  f.options.makeAuth = options => {
    const client = new AitermClient({ command: 'must-not-spawn', env: {} }), transport = { pid: 123 }
    const sdk = { transport, listTools: async () => ({ tools: [authTool()] }), getServerVersion: () => ({ name: 'aiterm', version: f.document.target.version }), callTool: async ({ arguments: args }) => {
      issued.push({ action: args.action, at: Date.now() })
      return args.action === 'cancel' ? { structuredContent: { schema: 'aiterm.agent-auth-result.v1', harness: 'claude-code', session_id: null, status: 'blocked' } } : result(args.action === 'respond')
    } }
    client.connect = async () => { f.counts.initialize++; client.client = sdk; client.transport = transport }
    client.close = async () => { f.counts.close++; client.client = null; client.transport = null }
    const raw = createOlrwRabbitAuth({ ...options, client })
    return { ...raw, respond: (...args) => {
      queueMicrotask(() => { if (boundary === 'close') void caller.close(); else offset = boundary === 'input' ? 600001 : 900001 })
      return raw.respond(...args)
    } }
  }
  caller = await f.start(); await until(() => f.counts.initialize === 1); f.evidence()
  const journal = async () => (await readFile(join(f.root, 'state/olrw-auth/synthetic-run.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  await until(async () => { try { return (await journal()).at(-1).phase === 'awaiting_secret' } catch { return false } })
  await f.secrets.submit([...f.secrets.items.values()][0].id, 'SYNTHETIC-CODE')
  const answer = await caller.result
  assert.deepEqual(issued.map(x => x.action), ['start', 'status'])
  assert.equal(f.counts.initialize, 1)
  assert.equal((await journal()).at(-1).consumed, true)
  assert.notEqual(answer.outcome, 'confirmed')
  if (boundary !== 'close') assert.equal(answer.reason, 'expired')
})
