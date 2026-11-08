import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { AitermTransport } from '../src/aiterm-transport.mjs'
import { createScreenInputApi } from '../src/http-screen-input-api.mjs'

// N5 (execution/screen-input.md): Owner key / approval input through Aiterm's public tools only.
const digest = 'sha256:' + 'a'.repeat(64)
function fixture({ running = true, approval = 'shown' } = {}) {
  const calls = []
  const transport = new AitermTransport({ client: { async call(name, args) {
    calls.push([name, args])
    if (name === 'pty_list') return { content: [{ type: 'text', text: running ? 'bot-a\tclaude' : '' }] }
    if (name === 'pty_key') return { structuredContent: { outcome: 'accepted' } }
    if (args?.action === 'inspect') {
      if (approval !== 'shown') throw new Error('no approval')
      return { structuredContent: { status: 'approval_required', prompt_digest: digest,
        choices: [{ decision: 'approve_once', index: 1, label: 'Yes' }, { decision: 'deny', index: 3, label: 'No' }] } }
    }
    if (args?.action === 'respond') {
      if (args.observed_prompt_digest !== digest) throw new Error('changed')
      return { structuredContent: { status: 'submitted' } }
    }
    assert.fail('unexpected ' + name)
  }, async close() {} } })
  return { transport, calls }
}
const claude = { id: 'bot-a', session: 'bot-a', harness: 'claude' }

test('keys: closed set to pty_key on the seat; absent seat and other keys refused', async t => {
  const f = fixture(); t.after(() => f.transport.close())
  assert.deepEqual(await f.transport.screenKey(claude, 'Escape'), { key: 'Escape', outcome: 'accepted' })
  assert.deepEqual(f.calls.at(-1), ['pty_key', { session_id: 'bot-a', key: 'Escape' }])
  for (const key of ['Enter', 'Tab', 'Up', '7', 'C-c']) await f.transport.screenKey(claude, key)
  for (const key of ['C-d', 'a', 'Enter; rm', undefined]) await assert.rejects(f.transport.screenKey(claude, key), { code: 'SCREEN_KEY_INVALID', status: 400 })
  const absent = fixture({ running: false }); t.after(() => absent.transport.close())
  await assert.rejects(absent.transport.screenKey(claude, 'Enter'), { code: 'SCREEN_SEAT_ABSENT', status: 409 })
})

test('approval: Claude anonymous inspect/respond, none when no dialog, unsupported harness', async t => {
  const f = fixture(); t.after(() => f.transport.close())
  assert.deepEqual(await f.transport.screenApproval(claude, { action: 'inspect' }), { status: 'approval_required', promptDigest: digest,
    choices: [{ decision: 'approve_once', label: 'Yes' }, { decision: 'deny', label: 'No' }] })
  assert.deepEqual(f.calls.at(-1), ['claude_approval', { action: 'inspect', session_id: 'bot-a' }])
  assert.deepEqual(await f.transport.screenApproval(claude, { action: 'respond', decision: 'deny', promptDigest: digest }), { status: 'submitted', decision: 'deny' })
  await assert.rejects(f.transport.screenApproval(claude, { action: 'respond', decision: 'deny', promptDigest: 'sha256:' + 'b'.repeat(64) }), { code: 'SCREEN_APPROVAL_CHANGED' })
  await assert.rejects(f.transport.screenApproval(claude, { action: 'respond', decision: 'always', promptDigest: digest }), { code: 'SCREEN_APPROVAL_INVALID' })
  await f.transport.screenApproval({ ...claude, harness: 'codex' }, { action: 'inspect' })
  assert.equal(f.calls.at(-1)[0], 'agent_approval')
  assert.deepEqual(await f.transport.screenApproval({ ...claude, harness: 'grok' }, { action: 'inspect' }), { status: 'none' })
  await assert.rejects(f.transport.screenApproval({ ...claude, harness: 'grok' }, { action: 'respond', decision: 'deny', promptDigest: digest }), { code: 'SCREEN_APPROVAL_UNSUPPORTED' })
  const none = fixture({ approval: 'none' }); t.after(() => none.transport.close())
  assert.deepEqual(await none.transport.screenApproval(claude, { action: 'inspect' }), { status: 'none' })
})

test('HTTP: Owner only, routes and error codes', async t => {
  const f = fixture(); t.after(() => f.transport.close())
  const bots = new Map([['bot-a', claude]])
  const call = async (api, method, path, body) => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    Object.assign(request, { method, headers: { 'content-type': 'application/json' } })
    const response = { status: 0, body: '', writeHead(status) { this.status = status; return this }, setHeader() {}, end(value) { this.body = value ?? '' } }
    const handled = await api(request, response, new URL('http://x' + path))
    return handled === false ? false : { status: response.status, body: response.body ? JSON.parse(response.body) : null }
  }
  const owner = createScreenInputApi({ bots, transport: f.transport, internal: false })
  const bot = createScreenInputApi({ bots, transport: f.transport, internal: true })
  assert.deepEqual(await call(owner, 'POST', '/api/bots/bot-a/screen/key', { key: 'Enter' }), { status: 200, body: { key: 'Enter', outcome: 'accepted' } })
  assert.deepEqual(await call(bot, 'POST', '/api/bots/bot-a/screen/key', { key: 'Enter' }), { status: 403, body: { error: 'SCREEN_INPUT_OWNER_REQUIRED' } })
  assert.equal((await call(owner, 'POST', '/api/bots/bot-a/screen/key', { key: 'x' })).status, 400)
  assert.equal((await call(owner, 'POST', '/api/bots/bot-zz/screen/key', { key: 'Enter' })).status, 404)
  assert.equal((await call(owner, 'GET', '/api/bots/bot-a/screen/key')).status, 405)
  assert.equal((await call(owner, 'GET', '/api/bots/bot-a/screen/approval')).body.status, 'approval_required')
  assert.deepEqual((await call(owner, 'POST', '/api/bots/bot-a/screen/approval', { decision: 'approve_once', promptDigest: digest })).body, { status: 'submitted', decision: 'approve_once' })
  assert.equal(await call(owner, 'GET', '/api/bots/bot-a/screen'), false)
})
