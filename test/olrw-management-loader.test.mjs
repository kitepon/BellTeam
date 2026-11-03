import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareOlrwManagement, readOlrwManagedFile, OLRW_MANAGEMENT_PATHS as paths } from '../src/olrw-management-loader.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
async function fixture(t, answered = false) {
  const root = await mkdtemp(join(tmpdir(), 'olrw-loader-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const question = { id: 'synthetic-question', botId: 'bot-synthetic', question: 'synthetic start?', options: ['yes', 'no'], allowOther: false, status: answered ? 'answered' : 'open' }
  const decision = { decision_id: 'K-ABC123', version: 3, requester: 'synthetic', status: 'answered', context: 'synthetic fixed profile and initializer permission',
    options: [{ id: 'allow', label: 'synthetic' }], answer: { option_id: 'allow', answered_at: new Date().toISOString() } }
  const document = { schema: 'bellteam.olrw-auth.management.v1',
    context: { runId: 'synthetic-run', sessionId: 'synthetic-auth', protectedHosted: 'protected-hosted', requesterBotId: question.botId, roomId: null, toolId: 'olrw-auth', expiresAt: new Date(Date.now() + 60000).toISOString() },
    question: { questionId: question.id, requesterBotId: question.botId, question: question.question, options: question.options, answer: 'yes' },
    target: { nodePath: '/approved/node', entryPath: '/approved/aiterm/dist/index.js', version: '99.1.2', profileSha256: 'c'.repeat(64) },
    approval: { decisionId: decision.decision_id, version: decision.version, requester: decision.requester, connectionId: 'connection', userId: 'owner', optionId: 'allow', contextSha256: hash(decision.context), optionsSha256: hash(JSON.stringify(decision.options)) } }
  const records = new Map([[paths.plan, Buffer.from(JSON.stringify(document))], [paths.token, Buffer.from('synthetic-token\n')]])
  const current = { parentPid: 100, parentStarted: 'birth1', sshPid: 101, sshStarted: 'birth2' }
  const counts = { initialize: 0, close: 0, get: 0, auth: 0, token: 0 }
  const options = { root, ownerQuestions: { get: () => question },
    // Positive root ownership is modeled; actual credentials/root files are never read.
    readManaged: async path => { if (path === paths.token) counts.token++; if (!records.has(path)) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return records.get(path) },
    makeAuth: () => ({ prepare: async () => { counts.initialize++; return {} }, close: async () => { counts.close++ } }),
    metadata: async () => ({ ...current }), fetchImpl: async url => { counts.get++; return Response.json(url.endsWith('/connection') ? { connection_id: 'connection', me: { user_id: 'owner' } } : decision) } }
  return { options, records, question, document, current, counts }
}

test('既回答/plan不在はtoken・原本・MCPを触らず、可変祖先の実fileを拒否する', async t => {
  const f = await fixture(t, true)
  const prepared = await prepareOlrwManagement(f.options)
  assert.equal(prepared.auth, null)
  assert.deepEqual(f.counts, { initialize: 0, close: 0, get: 0, auth: 0, token: 0 })
  f.records.delete(paths.plan)
  assert.equal(await prepareOlrwManagement(f.options), null)
  const file = join(f.options.root, 'untrusted'); await writeFile(file, 'synthetic', { mode: 0o440 })
  await assert.rejects(readOlrwManagedFile(file, 100), /OLRW_MANAGEMENT_UNAVAILABLE/)
})

test('initialize許可後の同接続名札を出しroot実測証跡の一致前はauth権限を返さない', async t => {
  const f = await fixture(t)
  let revokeDuringFetch = false
  const fetchImpl = f.options.fetchImpl
  f.options.fetchImpl = async url => {
    const result = await fetchImpl(url)
    if (revokeDuringFetch && !url.endsWith('/connection')) f.records.delete(paths.evidence)
    return result
  }
  const prepared = await prepareOlrwManagement(f.options)
  assert.equal(f.counts.initialize, 1)
  assert.equal(f.counts.get, 2)
  const preflight = JSON.parse(await readFile(join(f.options.root, 'logs/olrw-client-preflight.json'), 'utf8'))
  const evidence = { schema: preflight.schema, runId: preflight.runId, profileSha256: preflight.profileSha256, ...f.current }
  await assert.rejects(prepared.assertAuthorized('start'), /OLRW_MANAGEMENT_UNAVAILABLE/)
  f.records.set(paths.evidence, Buffer.from(JSON.stringify(evidence)))
  assert.equal(await prepared.assertAuthorized('start'), undefined)
  assert.equal(f.counts.get, 4)
  revokeDuringFetch = true
  await assert.rejects(prepared.assertAuthorized('respond'), /OLRW_MANAGEMENT_UNAVAILABLE/)
  revokeDuringFetch = false
  f.records.set(paths.evidence, Buffer.from(JSON.stringify(evidence)))
  f.current.sshStarted = 'replaced'
  await assert.rejects(prepared.assertAuthorized('status'), /OLRW_MANAGEMENT_UNAVAILABLE/)
  f.current.sshStarted = evidence.sshStarted
  f.records.set(paths.evidence, Buffer.from(JSON.stringify({ ...evidence, profileSha256: 'd'.repeat(64) })))
  await assert.rejects(prepared.assertAuthorized('respond'), /OLRW_MANAGEMENT_UNAVAILABLE/)
  f.records.set(paths.evidence, Buffer.from(JSON.stringify(evidence)))
  f.records.set(paths.plan, Buffer.from(JSON.stringify({ ...f.document, target: { ...f.document.target, version: '99.1.3' } })))
  await assert.rejects(prepared.assertAuthorized('cancel'), /OLRW_MANAGEMENT_UNAVAILABLE/)
  assert.equal(f.counts.auth, 0)
  await prepared.auth.close()
})

test('不正profile/許可拒否/初期化失敗を固定拒否し、作った接続を回収する', async t => {
  const f = await fixture(t)
  f.records.set(paths.plan, Buffer.from(JSON.stringify({ ...f.document, target: { ...f.document.target, entryPath: '/bad;command' } })))
  await assert.rejects(prepareOlrwManagement(f.options), /OLRW_MANAGEMENT_UNAVAILABLE/)
  assert.equal(f.counts.token, 0)
  f.records.set(paths.plan, Buffer.from(JSON.stringify(f.document)))
  await assert.rejects(prepareOlrwManagement({ ...f.options, fetchImpl: async () => { throw new Error('synthetic-token') } }), { message: 'OLRW_MANAGEMENT_UNAVAILABLE' })
  assert.equal(f.counts.initialize, 0)
  await assert.rejects(prepareOlrwManagement({ ...f.options, makeAuth: () => ({ prepare: async () => { throw new Error('init failure') }, close: async () => { f.counts.close++ } }) }), /OLRW_MANAGEMENT_UNAVAILABLE/)
  assert.equal(f.counts.close, 1)
})
