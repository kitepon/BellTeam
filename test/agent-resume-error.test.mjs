import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'

const refusal = code => ({ schema: 'aiterm.agent-resume-error.v1', code,
  session_id: 'bot-a', launch_id: 'a'.repeat(32), input: 'not_sent', recovery: 'inspect_session' })
const errorResult = structuredContent => ({ isError: true, structuredContent,
  content: [{ type: 'text', text: 'synthetic resume failure without matching wording' }] })

for (const code of ['AGENT_RESUME_UNCONFIRMED', 'AGENT_RESUME_FAILED']) {
  test(`${code}の型付き未送信は409で返し、席不在でも起動や再送を行わない`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bellteam-resume-error-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const calls = [], client = new AitermClient(), receipt = refusal(code)
    client.client = { async callTool({ name }) {
      calls.push(name)
      if (name === 'pty_send') return errorResult(receipt)
      if (name === 'pty_list') return { content: [{ type: 'text', text: '(セッション無し)' }] }
      throw new Error(`unexpected ${name}`)
    } }
    const bot = { id: 'bot-a', session: 'bot-a', harness: 'codex', project: root }
    const bots = new Map([[bot.id, bot]]), transport = new AitermTransport({ client })
    const messenger = new BellTeamMessenger({ bots, transport, logPath: join(root, 'messages.jsonl') })
    const diagnostics = []
    const server = createBellTeamServer({ bots, transport, messenger, store: messenger.store,
      authorize: async () => true, diagnostics: { async record(value) { diagnostics.push(value) } } })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise(resolve => server.close(resolve)))
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/bot-a/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'synthetic unsent body' }),
    })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.equal(body.error, 'BOT_INPUT_NOT_READY')
    assert.match(body.message, /今回のメッセージは送信されませんでした。再送せず/u)
    assert.deepEqual(calls, ['pty_send'])
    await transport.idle(bot.id)
    const records = await messenger.store.records()
    assert.equal(records.length, 1)
    assert.equal(records[0].message, 'synthetic unsent body')
    assert.equal(records[0].delivery, 'failed')
    assert.deepEqual(diagnostics, [])
  })
}

test('Aiterm 0.70.43以降の_metaに載った型付き復帰拒否も同じに分類する', async () => {
  const client = new AitermClient()
  client.client = { async callTool() { return { isError: true, _meta: { 'aiterm/resume_error': refusal('AGENT_RESUME_FAILED') },
    content: [{ type: 'text', text: 'synthetic resume failure without matching wording' }] } } }
  await assert.rejects(client.call('pty_send', { session_id: 'bot-a' }), error =>
    error.status === 409 && error.code === 'BOT_INPUT_NOT_READY' && error.agentResumeResult?.code === 'AGENT_RESUME_FAILED')
})

test('復帰拒否の分類は完全な同sessionの型だけを受け、欠測や文言から未送信を補わない', async () => {
  const client = new AitermClient()
  let result = errorResult(refusal('AGENT_RESUME_FAILED'))
  client.client = { async callTool() { return result } }
  await assert.rejects(client.call('pty_send', { session_id: 'bot-a' }), error => {
    assert.deepEqual(error.agentResumeResult, refusal('AGENT_RESUME_FAILED'))
    return error.status === 409
  })
  for (const change of [{ schema: 'wrong' }, { code: 'other' }, { session_id: 'bot-b' },
    { launch_id: null }, { launch_id: 'invalid' }, { input: 'unknown' }, { recovery: 'retry' }, { extra: true }]) {
    result = errorResult({ ...refusal('AGENT_RESUME_FAILED'), ...change })
    await assert.rejects(client.call('pty_send', { session_id: 'bot-a' }), error => error.status === undefined && error.agentResumeResult === undefined)
  }
  result = errorResult(undefined)
  result.content[0].text = 'aiterm: AGENT_RESUME_UNCONFIRMED: 本文は送信していません。'
  await assert.rejects(client.call('pty_send', { session_id: 'bot-a' }), error => error.status === undefined)
  result = errorResult(refusal('AGENT_RESUME_FAILED'))
  await assert.rejects(client.call('pty_read', { session_id: 'bot-a' }), error => error.status === undefined)
  result._meta = { 'aiterm/execution_error': { schema: 'aiterm.execution-error.v1',
    code: 'EXECUTION_UNCONFIRMED', effect: 'possible', follow_up: 'status_only' } }
  await assert.rejects(client.call('pty_send', { session_id: 'bot-a' }), error =>
    error.status === undefined && error.agentResumeResult === undefined && error.executionError.effect === 'possible')
})
