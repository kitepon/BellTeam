import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import test from 'node:test'

import { createBellTeamServer } from '../src/http-server.mjs'

async function start(t, bots) {
  const lines = []
  const server = createBellTeamServer({ bots, authorize: async () => true, writeLog: line => lines.push(line) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return { lines, base: `http://127.0.0.1:${server.address().port}` }
}

async function settled(lines, count) {
  for (let i = 0; i < 100 && lines.length < count; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
}

test('書き込み系の要求は、時刻・メソッド・パス・状態コードを1行残す。読み取りと問い合わせ文字列は残さない', async t => {
  const bots = new Map([['bot-a', { id: 'bot-a' }]])
  bots.previewUpdate = async id => ({ ...bots.get(id) })
  bots.update = async id => bots.get(id)
  const { lines, base } = await start(t, bots)

  assert.equal((await fetch(`${base}/api/bots/bot-a`)).status, 200)
  const saved = await fetch(`${base}/api/bots/bot-a?token=secret`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '本文は残さない' }),
  })
  assert.equal(saved.status, 200)
  await saved.arrayBuffer()
  const missing = await fetch(`${base}/api/bots/bot-none`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(missing.status, 404)
  await missing.arrayBuffer()
  await settled(lines, 2)

  assert.equal(lines.length, 2)
  assert.match(lines[0], /^BellTeam write: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z PATCH \/api\/bots\/bot-a 200 \d+ms\n$/u)
  assert.match(lines[1], /^BellTeam write: \S+ PATCH \/api\/bots\/bot-none 404 \d+ms\n$/u)
  assert.equal(lines.join('').includes('secret'), false)
  assert.equal(lines.join('').includes('本文'), false)
})

test('応答を返し終える前に接続が切れた書き込みは aborted と残す', async t => {
  const bots = new Map([['bot-a', { id: 'bot-a' }]])
  let release
  bots.previewUpdate = () => new Promise(resolve => { release = () => resolve({ id: 'bot-a' }) })
  bots.update = async id => bots.get(id)
  const { lines, base } = await start(t, bots)

  const client = httpRequest(`${base}/api/bots/bot-a`, { method: 'PATCH', headers: { 'content-type': 'application/json' } })
  client.on('error', () => {})
  client.end('{}')
  for (let i = 0; i < 100 && !release; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(typeof release, 'function')
  client.destroy()
  await settled(lines, 1)
  release()

  assert.equal(lines.length, 1)
  assert.match(lines[0], /^BellTeam write: \S+ PATCH \/api\/bots\/bot-a aborted \d+ms\n$/u)
})
