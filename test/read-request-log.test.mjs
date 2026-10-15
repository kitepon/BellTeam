import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import test from 'node:test'

import { createBellTeamServer } from '../src/http-server.mjs'

async function start(t, options = {}) {
  const lines = []
  const server = createBellTeamServer({ bots: new Map(), authorize: async () => true, ...options, writeLog: line => lines.push(line) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return { lines, server, base: `http://127.0.0.1:${server.address().port}` }
}

async function settled(lines, count) {
  for (let i = 0; i < 100 && lines.length < count; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lines.length, count)
}

test('GETの受付と完了を残し、問い合わせ文字列と認証ヘッダーを含めない', async t => {
  const { lines, base } = await start(t)
  const response = await fetch(`${base}/api/session?token=query-secret`, {
    headers: { cookie: 'cookie-secret', authorization: 'Bearer header-secret' },
  })
  assert.equal(response.status, 200)
  await response.arrayBuffer()
  await settled(lines, 2)
  assert.match(lines[0], /^BellTeam read: \S+ GET \/api\/session started\n$/u)
  assert.match(lines[1], /^BellTeam read: \S+ GET \/api\/session 200 \d+ms\n$/u)
  assert.equal(lines[0].split(' ')[2], lines[1].split(' ')[2])
  assert.equal(lines.join('').includes('secret'), false)
})

test('応答を待っている間に受付を残し、途中切断をabortedとして残す', async t => {
  let accept
  const received = new Promise(resolve => { accept = resolve })
  let release
  const { lines, base } = await start(t, { authorize: () => new Promise(resolve => { release = () => resolve(true); accept() }) })
  const client = httpRequest(`${base}/api/session`)
  client.on('error', () => {})
  client.end()
  await received
  assert.equal(lines.length, 1)
  assert.match(lines[0], /GET \/api\/session started\n$/u)
  client.destroy()
  await settled(lines, 2)
  release()
  assert.match(lines[1], /GET \/api\/session aborted \d+ms\n$/u)
})

test('GETのサーバー500も終了として記録し、例外の本文を要求ログへ含めない', async t => {
  const { lines, base } = await start(t, { authorize: async () => { throw new Error('private-error-secret') } })
  const response = await fetch(`${base}/api/session`)
  assert.equal(response.status, 500)
  await response.arrayBuffer()
  await settled(lines, 2)
  assert.match(lines[1], /GET \/api\/session 500 \d+ms\n$/u)
  assert.equal(lines.join('').includes('secret'), false)
})

test('HEADの状態を残し、healthzは記録を増やさない', async t => {
  const { lines, base } = await start(t)
  const head = await fetch(`${base}/api/missing`, { method: 'HEAD' })
  assert.equal(head.status, 404)
  await settled(lines, 2)
  assert.match(lines[0], /HEAD \/api\/missing started\n$/u)
  assert.match(lines[1], /HEAD \/api\/missing 404 \d+ms\n$/u)
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
  assert.equal(lines.length, 2)
})

test('SSEは受付と閉鎖だけを残し、配信中の通知ごとにはログを増やさない', async t => {
  const { lines, server, base } = await start(t)
  const cancel = new AbortController()
  const response = await fetch(`${base}/api/events`, { signal: cancel.signal })
  const reader = response.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/u)
  server.notify({ type: 'bots' })
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"bots"/u)
  assert.equal(lines.length, 1)
  cancel.abort()
  await settled(lines, 2)
  assert.match(lines[0], /GET \/api\/events started\n$/u)
  assert.match(lines[1], /GET \/api\/events aborted \d+ms\n$/u)
})
