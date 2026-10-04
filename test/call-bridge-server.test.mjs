import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createCallBridgeServer, listenCallBridge } from '../src/call-bridge-server.mjs'
import { BellTeamMessenger } from '../src/messenger.mjs'

function call(socketPath, method, path, body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, response => {
      let text = ''
      response.setEncoding('utf8').on('data', chunk => { text += chunk }).on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }))
    })
    request.once('error', reject)
    request.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

test('通話電話帳をUNIXソケットで提供し、外部発信者を本人として偽装せずBotへ配送する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-call-'))
  const socketPath = join(root, 'bridge.sock')
  const bot = { id: 'bot-a', name: 'トロニー', position: 'GrokBotBridge整備', role: '電子工学' }
  const bots = new Map([[bot.id, bot]])
  const sent = []
  const messenger = new BellTeamMessenger({
    bots, logPath: join(root, 'messages.jsonl'),
    transport: { async notify(target, text, options) { sent.push({ target, text, options }); return { delivery: 'running' } } },
  })
  const close = await listenCallBridge(createCallBridgeServer({ bots, messenger }), socketPath)
  try {
    const directory = await call(socketPath, 'GET', '/v0/directory')
    assert.equal(directory.status, 200)
    assert.deepEqual(directory.body.members, [{ system: 'bellteam', id: 'bot-a', name: 'トロニー', title: 'GrokBotBridge整備', role: '電子工学' }])
    const delivered = await call(socketPath, 'POST', '/v0/deliver', {
      schema: 'call-bridge.delivery.v1', event: 'session.message', session_id: 'session-1',
      target_id: 'bot-a', source_system: 'grokbot', source_id: 'grok-1', source_label: 'ラピ',
      message: '電力を確認して', reply_required: true,
    })
    assert.equal(delivered.status, 200)
    assert.equal(delivered.body.delivery, 'running')
    assert.match(sent[0].text, /session_id=session-1/u)
    assert.match(sent[0].text, /from_party=member/u)
    const records = (await readFile(join(root, 'messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(records[0].from, 'call-bridge:grokbot:grok-1')
    assert.equal(records[0].from_identity.name, 'ラピ')
    assert.equal(records[0].target, 'bot-a')
    const reply = await call(socketPath, 'POST', '/v0/deliver', {
      schema: 'call-bridge.delivery.v1', event: 'session.reply', session_id: 'session-1', seq: 2,
      target_id: 'bot-a', source_system: 'grokbot', source_id: 'grok-1', source_label: 'ラピ',
      message: '確認したよ', reply_required: true,
    })
    assert.equal(reply.status, 200)
    assert.match(sent[1].text, /from_party=local/u)
  } finally {
    await close()
    await rm(root, { recursive: true, force: true })
  }
})

test('未知の宛先と不正な配送を明示的に拒否する', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-call-'))
  const socketPath = join(root, 'bridge.sock')
  const bots = new Map()
  const messenger = new BellTeamMessenger({ bots, logPath: join(root, 'messages.jsonl'), transport: { notify() { throw new Error('unexpected') } } })
  const close = await listenCallBridge(createCallBridgeServer({ bots, messenger }), socketPath)
  try {
    const bad = await call(socketPath, 'POST', '/v0/deliver', { event: 'session.message' })
    assert.equal(bad.status, 400)
    const missing = await call(socketPath, 'POST', '/v0/deliver', {
      schema: 'call-bridge.delivery.v1', event: 'session.message', session_id: 's', target_id: 'missing',
      source_system: 'local', source_id: 'caller', source_label: 'Caller', message: 'hello',
    })
    assert.equal(missing.status, 404)
  } finally {
    await close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Aitermへの受付失敗を通話ブリッジへ成功として返さない', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-call-'))
  const socketPath = join(root, 'bridge.sock')
  const bot = { id: 'bot-a', name: 'トロニー' }
  const bots = new Map([[bot.id, bot]])
  const messenger = new BellTeamMessenger({
    bots, logPath: join(root, 'messages.jsonl'),
    transport: { async notify() { throw new Error('AITERM_UNAVAILABLE') } },
  })
  const close = await listenCallBridge(createCallBridgeServer({ bots, messenger }), socketPath)
  try {
    const result = await call(socketPath, 'POST', '/v0/deliver', {
      schema: 'call-bridge.delivery.v1', event: 'session.message', session_id: 's', target_id: 'bot-a',
      source_system: 'local', source_id: 'caller', source_label: 'Caller', message: 'hello',
    })
    assert.equal(result.status, 502)
    const records = (await readFile(join(root, 'messages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(records.at(-1).delivery, 'failed')
  } finally {
    await close()
    await rm(root, { recursive: true, force: true })
  }
})
