import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { AitermClient, AitermTransport } from '../src/aiterm-transport.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'

async function delayedServer(t, { failFirst = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-mcp-connect-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const command = join(root, 'server.mjs')
  await writeFile(command, `#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { existsSync, writeFileSync } from 'node:fs'
const marker = ${JSON.stringify(join(root, 'initialized-once'))}
let initialized = false
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    setTimeout(() => {
      if (${failFirst} && !existsSync(marker)) {
        writeFileSync(marker, '')
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fixture initialization failed' } }) + '\\n')
        return
      }
      initialized = true
      reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'isolated-fixture', version: '1' } })
    }, 80)
  } else if (request.method === 'tools/call') {
    reply(request.id, request.params.name === 'pty_send'
      ? initialized
        ? { content: [], structuredContent: { mode: 'agent_steer' } }
        : { isError: true, content: [{ type: 'text', text: 'fixture not initialized' }] }
      : { content: [{ type: 'text', text: initialized ? 'initialized' : 'called-too-early' }] })
    if (request.params.name === 'disconnect-after-response') setTimeout(() => process.exit(0), 20)
  } else if (request.id !== undefined) reply(request.id, {})
})
`)
  await chmod(command, 0o700)
  return command
}

test('同時の最初のMCP呼出しは同じ初期化の完了を待つ', { timeout: 5000 }, async t => {
  const command = await delayedServer(t)
  const client = new AitermClient({ command })
  t.after(() => client.close())
  const results = await Promise.allSettled([client.call('first'), client.call('second'), client.call('third')])
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled'])
  for (const result of results) assert.equal(result.value.content[0].text, 'initialized')
})

test('MCP初期化失敗を返した後の別の呼出しで接続を作り直せる', { timeout: 5000 }, async t => {
  const command = await delayedServer(t, { failFirst: true })
  const client = new AitermClient({ command })
  t.after(() => client.close())
  const failed = await Promise.allSettled([client.call('first'), client.call('second'), client.call('third')])
  assert.deepEqual(failed.map(result => result.status), ['rejected', 'rejected', 'rejected'])
  for (const result of failed) {
    assert.match(result.reason.message, /fixture initialization failed/u)
    assert.equal(result.reason, failed[0].reason)
  }
  const result = await client.call('next-user-request')
  assert.equal(result.content[0].text, 'initialized')
})

test('MCP終了後の別の要求は接続を作り直し、受け付けた要求を再送しない', { timeout: 5000 }, async t => {
  const command = await delayedServer(t)
  const client = new AitermClient({ command })
  t.after(() => client.close())
  await client.call('first')
  const closed = new Promise(resolve => {
    const onclose = client.client.onclose
    client.client.onclose = () => { onclose?.(); resolve() }
  })
  assert.equal((await client.call('disconnect-after-response')).content[0].text, 'initialized')
  await closed
  const result = await client.call('next-user-request')
  assert.equal(result.content[0].text, 'initialized')
})

test('初回接続中の別Bot宛て同時POSTも500にせず各1件を受け付ける', { timeout: 5000 }, async t => {
  const command = await delayedServer(t)
  const client = new AitermClient({ command })
  const transport = new AitermTransport({ client })
  const root = dirname(command)
  const bots = new Map(['bot-a', 'bot-b'].map(id => [id, { id, session: id, harness: 'codex', project: root }]))
  const messenger = new BellTeamMessenger({ bots, transport, logPath: join(root, 'messages.jsonl') })
  const diagnostics = []
  const server = createBellTeamServer({ bots, transport, messenger, store: messenger.store,
    authorize: async () => true, diagnostics: { async record(value) { diagnostics.push(value) } } })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await transport.close()
  })
  const results = await Promise.all([...bots.keys()].map(id => fetch(`http://127.0.0.1:${server.address().port}/api/bots/${id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'isolated-fixture-message' }),
  })))
  assert.deepEqual(results.map(result => result.status), [200, 200])
  for (const result of results) assert.equal((await result.json()).delivery, 'steered')
  await Promise.all([...bots.keys()].map(id => transport.idle(id)))
  const records = await messenger.store.records()
  assert.equal(records.filter(record => record.from === 'user').length, 2)
  assert.equal(records.some(record => record.delivery === 'failed'), false)
  assert.deepEqual(diagnostics, [])
})
