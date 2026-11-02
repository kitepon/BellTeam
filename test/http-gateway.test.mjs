import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createHttpGatewayProcess } from '../src/http-gateway-process.mjs'
import { createApplicationRuntime } from '../src/application-runtime.mjs'
import { BotRegistry } from '../src/bot-registry.mjs'
import { FeatureSettings } from '../src/feature-settings.mjs'
import { OwnerProfile } from '../src/owner-profile.mjs'
import { UserRules } from '../src/user-rules.mjs'

const appRoot = fileURLToPath(new URL('../', import.meta.url))

test('公開受付の終了・kill・起動失敗から業務実行を止めず、回答を一回保存して再接続する', { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-gateway-runtime-'))
  const seedPath = join(root, 'seed.json')
  await writeFile(seedPath, JSON.stringify({ schema: 'bellteam.bots.v1', bots: [
    { id: 'bot-synthetic', name: 'Synthetic', harness: 'codex', session: 'bot-synthetic', project: join(root, 'bots/bot-synthetic') },
  ] }))
  const bots = new BotRegistry({ seedPath, botsRoot: join(root, 'bots') })
  const settings = new FeatureSettings({ root, environment: {} })
  const ownerProfile = new OwnerProfile({ root }), userRules = new UserRules({ root })
  for (const value of [bots, settings, ownerProfile, userRules]) await value.initialize()
  let clientClosed = 0, turns = 0
  const runtime = await createApplicationRuntime({ root, appRoot, home: join(root, 'home'),
    environment: { BELLTEAM_WEB_PORT: '0', BELLTEAM_INTERNAL_PORT: '0' },
    bootstrap: { bots, settings, ownerProfile, userRules, aiterm: { command: 'synthetic', args: ['/synthetic/native.js', '--execution-interrupt'] }, refreshGlobalInstructions: async () => {} },
    client: { async call() { return { content: [{ type: 'text', text: '(セッション無し)' }] } }, async close() { clientClosed++ } },
  })
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  const answer = Promise.withResolvers(), saved = Promise.withResolvers()
  runtime.services.transport.turn = (_bot, _message, options) => {
    turns++
    assert.equal(options.queue.target, 'bot-synthetic')
    answer.promise.accepted = Promise.resolve({ delivery: 'running' })
    return answer.promise
  }
  const finish = runtime.services.messenger.finishUserTurn.bind(runtime.services.messenger)
  runtime.services.messenger.finishUserTurn = (...args) => finish(...args).then(saved.resolve, saved.reject)
  await runtime.start()
  const socket = runtime.server.address()
  assert.equal((await stat(join(socket, '..'))).mode & 0o777, 0o700)
  const base = () => `http://127.0.0.1:${runtime.gateway.address.port}`
  const internal = `http://127.0.0.1:${runtime.internalServer.address().port}`
  const sse = await fetch(base() + '/api/events')
  const reader = sse.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/)
  const accepted = await (await fetch(base() + '/api/bots/bot-synthetic/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'synthetic question' }),
  })).json()
  assert.equal(accepted.delivery, 'running')
  assert.equal(turns, 1)
  const watchCount = runtime.services.store.listeners.size
  const closedStream = assert.rejects(reader.read(), TypeError)
  await runtime.gateway.close()
  await closedStream
  assert.equal(runtime.gateway.pid, null)
  assert.equal(clientClosed, 0)
  assert.equal(runtime.services.store.listeners.size, watchCount)
  assert.deepEqual(await (await fetch(internal + '/healthz')).json(), { status: 'ok' })
  answer.resolve('synthetic final answer')
  await saved.promise
  await runtime.gateway.start()
  const history = await (await fetch(base() + '/api/bots/bot-synthetic/messages')).json()
  assert.equal(history.items.filter(row => row.message === 'synthetic final answer').length, 1)
  assert.equal(turns, 1)
  const pid = runtime.gateway.pid
  process.kill(pid, 'SIGKILL')
  await runtime.gateway.close().catch(() => {})
  assert.equal(runtime.gateway.pid, null)
  assert.equal(clientClosed, 0)
  assert.deepEqual(await (await fetch(internal + '/healthz')).json(), { status: 'ok' })
  const blocker = createServer()
  blocker.listen(0, '0.0.0.0'); await once(blocker, 'listening')
  t.after(() => blocker.close())
  const conflict = createHttpGatewayProcess({ socketPath: socket, port: blocker.address().port, appRoot })
  await assert.rejects(conflict.start(), /GATEWAY_START_FAILED/)
  assert.equal(conflict.pid, null)
  assert.equal(clientClosed, 0)
  await runtime.gateway.start()
  const finalPid = runtime.gateway.pid
  if (process.platform === 'linux') assert.equal((await readFile(`/proc/${finalPid}/environ`)).includes(Buffer.from('BELLTEAM_ROOT=')), false)
  const closed = runtime.close()
  assert.equal(runtime.close(), closed)
  await closed
  assert.equal(clientClosed, 1)
  assert.equal(runtime.gateway.pid, null)
  await assert.rejects(stat(socket), { code: 'ENOENT' })
})

test('gatewayは認証・Host・日本語bytes・応答headerを保ち、資材だけを自分の版から返す', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-gateway-wire-'))
  const socketPath = join(root, 'backend.sock')
  const seen = []
  let mutations = 0
  const backend = createServer(async (request, response) => {
    seen.push({ url: request.url, host: request.headers.host, auth: request.headers.authorization, method: request.method })
    if (request.url === '/api/session') {
      response.setHeader('content-type', 'application/json')
      return response.end(JSON.stringify({ authenticated: request.headers.authorization === 'synthetic' }))
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    if (request.url === '/api/disconnect') { mutations++; return response.destroy() }
    response.writeHead(202, { 'content-type': 'application/octet-stream', 'x-synthetic-result': 'accepted' })
    response.end(Buffer.concat(chunks))
  })
  backend.listen(socketPath); await once(backend, 'listening')
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot })
  t.after(async () => { await gateway.close(); await new Promise(resolve => backend.close(resolve)); await rm(root, { recursive: true, force: true }) })
  await gateway.start()
  const base = `http://127.0.0.1:${gateway.address.port}`
  assert.equal((await fetch(base + '/')).status, 401)
  const headers = { authorization: 'synthetic', host: 'synthetic.example', 'content-type': 'application/octet-stream' }
  const bytes = Buffer.from('日本語\u0000test')
  const response = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(base + '/api/synthetic?x=1', { method: 'PATCH', headers }, incoming => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.once('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }))
      incoming.once('error', reject)
    })
    outgoing.once('error', reject)
    outgoing.end(bytes)
  })
  assert.equal(response.status, 202)
  assert.equal(response.headers['x-synthetic-result'], 'accepted')
  assert.deepEqual(response.body, bytes)
  assert.deepEqual(seen.at(-1), { url: '/api/synthetic?x=1', host: 'synthetic.example', auth: 'synthetic', method: 'PATCH' })
  assert.match(await (await fetch(base + '/', { headers })).text(), /<html/u)
  assert.equal((await fetch(base + '/missing', { headers })).status, 404)
  const unknown = await fetch(base + '/api/disconnect', { method: 'POST', body: 'once' })
  assert.equal(unknown.status, 502)
  assert.equal((await unknown.json()).error, 'GATEWAY_RESPONSE_UNKNOWN')
  assert.equal(mutations, 1)
  await new Promise(resolve => backend.close(resolve))
  const unavailable = await fetch(base + '/api/disconnect', { method: 'POST', body: 'new' })
  assert.equal(unavailable.status, 503)
  assert.equal((await unavailable.json()).error, 'GATEWAY_UPSTREAM_UNAVAILABLE')
  assert.equal(mutations, 1)
})

test('受付の正常終了は受信中の更新をdrainし、遅れて開くSSEを回収する', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'bellteam-gateway-drain-'))
  const socketPath = join(root, 'backend.sock')
  const received = Promise.withResolvers(), finish = Promise.withResolvers()
  const receivedSse = Promise.withResolvers(), sendSse = Promise.withResolvers()
  const backend = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    if (request.url === '/api/events') {
      receivedSse.resolve()
      await sendSse.promise
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('event: ready\ndata: {}\n\n')
    } else {
      received.resolve()
      await finish.promise
      response.end(Buffer.concat(chunks))
    }
  })
  backend.listen(socketPath); await once(backend, 'listening')
  const gateway = createHttpGatewayProcess({ socketPath, port: 0, appRoot })
  t.after(async () => { finish.resolve(); sendSse.resolve(); await gateway.close(); await new Promise(resolve => backend.close(resolve)); await rm(root, { recursive: true, force: true }) })
  await gateway.start()
  const response = fetch(`http://127.0.0.1:${gateway.address.port}/api/write`, { method: 'POST', body: 'one mutation' })
  await received.promise
  const closing = gateway.close()
  finish.resolve()
  assert.equal(await (await response).text(), 'one mutation')
  await closing
  assert.equal(gateway.pid, null)
  await gateway.start()
  const stream = fetch(`http://127.0.0.1:${gateway.address.port}/api/events`)
  const failedStream = assert.rejects(async () => {
    const response = await stream
    const reader = response.body.getReader()
    while (!(await reader.read()).done) {}
  }, TypeError)
  await receivedSse.promise
  const closeSse = gateway.close()
  sendSse.resolve()
  await closeSse
  await failedStream
  assert.equal(gateway.pid, null)
})
