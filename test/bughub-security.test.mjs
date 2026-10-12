import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { bugHubSecurityTools, createBugHubSecurity } from '../src/bughub-security.mjs'
import { bellTeamTools, callBellTeamTool } from '../src/mcp-tools.mjs'

const KEY = 'test-key-not-a-real-secret'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

async function configured(endpoint = 'http://bughub.test/api/security/v1/') {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-bughub-'))
  await mkdir(join(root, 'shared/tools/bughub'), { recursive: true })
  await writeFile(join(root, 'shared/tools/bughub/endpoint'), `${endpoint}\n`)
  await writeFile(join(root, 'shared/tools/bughub/headers'), `x-bughub-security-token: ${KEY}\n`)
  return root
}

// BugHub の代わり。受けた要求を覚えて、決めた応答を返す。
function bugHub(answer = () => [200, { ok: true }]) {
  const seen = []
  const request = async (url, options) => {
    seen.push({ url, method: options.method, headers: options.headers, body: options.body === undefined ? undefined : JSON.parse(options.body) })
    const [status, value] = answer(seen.at(-1))
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  }
  return { seen, request }
}

test('6つの道具は共通MCPの一覧に入り、どの席からも同じ形で呼べる', () => {
  const names = ['bughub_list_security_findings', 'bughub_get_security_finding', 'bughub_create_security_finding',
    'bughub_update_security_finding', 'bughub_resolve_security_finding', 'bughub_reopen_security_finding']
  assert.deepEqual(bugHubSecurityTools.map(tool => tool.name), names)
  for (const name of names) assert.ok(bellTeamTools.some(tool => tool.name === name))
  // 呼んだ席と鍵は、どの道具の引数にも無い。
  for (const tool of bugHubSecurityTools) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    for (const key of Object.keys(tool.inputSchema.properties)) assert.doesNotMatch(key, /actor|token|key/iu)
  }
})

test('読む道具は、鍵と呼んだ席を付けて送り、返りをそのまま返す', async () => {
  const hub = bugHub(({ url }) => url.endsWith('/findings/SEC-002')
    ? [200, { finding: { finding_id: 'SEC-002', version: 3 }, history: [{ action: 'create' }] }]
    : [200, { findings: [{ finding_id: 'SEC-002' }], notification: { queued: 0 } }])
  const call = createBugHubSecurity({ root: await configured(), request: hub.request })

  assert.deepEqual(await call({ name: 'bughub_list_security_findings', args: { state: 'open' }, from: 'bot-0000000a' }),
    { findings: [{ finding_id: 'SEC-002' }], notification: { queued: 0 } })
  assert.deepEqual(await call({ name: 'bughub_get_security_finding', args: { finding_id: 'SEC-002' }, from: 'bot-0000000b' }),
    { finding: { finding_id: 'SEC-002', version: 3 }, history: [{ action: 'create' }] })
  await call({ name: 'bughub_list_security_findings', args: {}, from: 'bot-0000000a' })

  assert.deepEqual(hub.seen.map(item => [item.method, item.url, item.headers['x-bughub-actor'], item.headers['x-bughub-security-token'], item.body]), [
    ['GET', 'http://bughub.test/api/security/v1/findings?state=open', 'bot-0000000a', KEY, undefined],
    ['GET', 'http://bughub.test/api/security/v1/findings/SEC-002', 'bot-0000000b', KEY, undefined],
    ['GET', 'http://bughub.test/api/security/v1/findings', 'bot-0000000a', KEY, undefined],
  ])
})

test('書く道具は、契約どおりの口へ送り、request_id を付けて結果にも返す', async () => {
  const hub = bugHub(({ method }) => [method === 'POST' ? 201 : 200, { finding: { finding_id: 'SEC-009', version: 1 }, replayed: false }])
  const call = createBugHubSecurity({ root: await configured('http://bughub.test/api/security/v1'), request: hub.request })
  const finding = { finding_id: 'SEC-009', target: 'ホスト', title: '題', severity: 'warn', summary: '要約',
    discovered_at: '2026-10-12T13:08:00+09:00', observed_at: '2026-10-12T13:12:00+09:00' }

  const created = await call({ name: 'bughub_create_security_finding', args: finding, from: 'bot-0000000a' })
  assert.match(created.request_id, UUID)
  assert.deepEqual({ ...created, request_id: undefined }, { finding: { finding_id: 'SEC-009', version: 1 }, replayed: false, request_id: undefined })
  const fixed = '11111111-1111-4111-8111-111111111111'
  await call({ name: 'bughub_update_security_finding', args: { request_id: fixed, finding_id: 'SEC-009', expected_version: 1, patch: { title: '直した題' } }, from: 'bot-0000000a' })
  await call({ name: 'bughub_resolve_security_finding', args: { finding_id: 'SEC-009', expected_version: 2,
    resolution: { summary: '塞がった', verified_at: '2026-10-12T15:00:00+09:00' } }, from: 'bot-0000000b' })
  await call({ name: 'bughub_reopen_security_finding', args: { finding_id: 'SEC-009', expected_version: 3, reason: 'また開いた', observed_at: '2026-10-13T09:00:00+09:00' }, from: 'bot-0000000b' })

  const [create, update, resolve, reopen] = hub.seen
  assert.deepEqual([create.method, create.url, create.headers['content-type']], ['POST', 'http://bughub.test/api/security/v1/findings', 'application/json'])
  assert.deepEqual(create.body, { ...finding, request_id: created.request_id })
  assert.deepEqual([update.method, update.url, update.body], ['PATCH', 'http://bughub.test/api/security/v1/findings/SEC-009',
    { request_id: fixed, expected_version: 1, patch: { title: '直した題' } }])
  assert.deepEqual([resolve.method, resolve.url, resolve.headers['x-bughub-actor']], ['POST', 'http://bughub.test/api/security/v1/findings/SEC-009/resolve', 'bot-0000000b'])
  assert.deepEqual(Object.keys(resolve.body).sort(), ['expected_version', 'request_id', 'resolution'])
  assert.deepEqual([reopen.url, reopen.body.reason, reopen.body.observed_at], ['http://bughub.test/api/security/v1/findings/SEC-009/reopen', 'また開いた', '2026-10-13T09:00:00+09:00'])
  // 呼んだ席は header だけ。本文には入れない（BugHub は本文の actor を受け付けない）。
  for (const item of hub.seen) assert.equal(JSON.stringify(item.body).includes('bot-0000000'), false)
})

test('断られた時は、BugHub の符号と request_id だけを返し、入力と鍵は写さない', async () => {
  const hub = bugHub(() => [409, { error: 'security_version_conflict' }])
  const call = createBugHubSecurity({ root: await configured(), request: hub.request })
  const request = '22222222-2222-4222-8222-222222222222'

  await assert.rejects(call({ name: 'bughub_update_security_finding', from: 'bot-0000000a',
    args: { request_id: request, finding_id: 'SEC-009', expected_version: 1, patch: { summary: '外へ出さない下書き' } } }), error => {
    assert.equal(error.message, `BUGHUB_SECURITY_HTTP_409: security_version_conflict request_id=${request}`)
    return true
  })
  const unauthorized = createBugHubSecurity({ root: await configured(), request: bugHub(() => [401, { error: 'unauthorized' }]).request })
  await assert.rejects(unauthorized({ name: 'bughub_list_security_findings', args: {}, from: 'bot-0000000a' }), error => {
    assert.equal(error.message, 'BUGHUB_SECURITY_HTTP_401: unauthorized')
    assert.equal(error.message.includes(KEY), false)
    return true
  })
  const broken = createBugHubSecurity({ root: await configured(), request: bugHub(() => [200, 'not json']).request })
  await assert.rejects(broken({ name: 'bughub_get_security_finding', args: { finding_id: 'SEC-009' }, from: 'bot-0000000a' }), /BUGHUB_SECURITY_RESPONSE_INVALID/u)
})

test('届いたか分からない時は送り直さず、同じ request_id で送り直せるように番号を返す', async () => {
  let calls = 0
  const call = createBugHubSecurity({ root: await configured(), request: async () => { calls += 1; throw new TypeError('fetch failed') } })
  await assert.rejects(call({ name: 'bughub_resolve_security_finding', from: 'bot-0000000a',
    args: { finding_id: 'SEC-009', expected_version: 2, resolution: { summary: '塞がった', verified_at: '2026-10-12T15:00:00+09:00' } } }),
  /^Error: BUGHUB_SECURITY_UNREACHABLE: request_id=[0-9a-f-]{36}$/u)
  assert.equal(calls, 1)
})

test('鍵と行き先が置かれていない間は、どこへも送らずに断る', async () => {
  const hub = bugHub()
  const empty = await mkdtemp(join(tmpdir(), 'bellteam-bughub-none-'))
  await assert.rejects(createBugHubSecurity({ root: empty, request: hub.request })({ name: 'bughub_list_security_findings', args: {}, from: 'bot-0000000a' }),
    /^Error: BUGHUB_SECURITY_NOT_CONFIGURED$/u)
  assert.equal(hub.seen.length, 0)
})

test('共通MCPの入口は、名札で決まった席を呼んだ席として渡し、知らない引数を断る', async () => {
  const registry = new Map([['bot-0000000a', { id: 'bot-0000000a' }]])
  registry.refresh = async () => registry
  const calls = []
  const context = { from: 'bot-0000000a', registry, rooms: null, bugHubSecurity: async value => { calls.push(value); return { findings: [] } } }

  assert.deepEqual(await callBellTeamTool({ ...context, name: 'bughub_list_security_findings', arguments: { state: 'resolved' } }), { findings: [] })
  assert.deepEqual(calls, [{ name: 'bughub_list_security_findings', args: { state: 'resolved' }, from: 'bot-0000000a' }])
  await assert.rejects(callBellTeamTool({ ...context, name: 'bughub_get_security_finding', arguments: { finding_id: 'SEC-002', actor: 'bot-0000000b' } }),
    /TOOL_ARGUMENT_INVALID: actor/u)
  await assert.rejects(callBellTeamTool({ ...context, bugHubSecurity: undefined, name: 'bughub_list_security_findings', arguments: {} }),
    /BUGHUB_SECURITY_NOT_CONFIGURED/u)
})
