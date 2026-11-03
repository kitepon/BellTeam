import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createECDH, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import webPush from 'web-push'
import { WebPushProvider } from '../src/web-push-provider.mjs'

test('real Node HTTPS completes or destroys its artificial TLS socket under the absolute deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-push-artificial-tls-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const key = join(root, 'synthetic-only-key.pem'), cert = join(root, 'synthetic-only-cert.pem')
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=fcm.googleapis.com', '-addext', 'subjectAltName=DNS:fcm.googleapis.com'])
  const ca = await readFile(cert)
  let requests = 0, closed = 0, received, sni, hang = false, sawRequest
  const server = createServer({ key: await readFile(key), cert: ca }, (req, res) => {
    requests++; sni = req.socket.servername
    const chunks = []
    req.on('data', value => chunks.push(value))
    req.on('end', () => {
      received = Buffer.concat(chunks)
      sawRequest?.()
      if (!hang) { res.writeHead(201); res.end('synthetic service receipt') }
    })
  })
  server.on('secureConnection', socket => socket.once('close', () => { closed++ }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const receiver = createECDH('prime256v1'); receiver.generateKeys()
  const subscription = { endpoint: 'https://fcm.googleapis.com/fixture', keys: {
    p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url'),
  } }
  const provider = new WebPushProvider({ vapid: { ...webPush.generateVAPIDKeys(), subject: 'mailto:operator@example.com' },
    timeoutMs: 1000, resolverFactory: () => ({ resolve4: async () => ['8.8.8.8'], resolve6: async () => [], cancel() {} }),
    request: options => {
      assert.equal(options.rejectUnauthorized, true)
      assert.equal(options.servername, 'fcm.googleapis.com')
      // This test transport reaches only its local TLS fixture; the product entry has no injection option.
      return request({ ...options, port: server.address().port, ca,
        lookup: (_host, _opts, done) => done(null, '127.0.0.1', 4) })
    },
  })
  assert.deepEqual(await provider.send(subscription, 'synthetic plaintext'), { accepted: true })
  assert.equal(sni, 'fcm.googleapis.com')
  assert.equal(received.includes('synthetic plaintext'), false)
  hang = true
  provider.timeoutMs = 100
  const entered = new Promise(resolve => { sawRequest = resolve })
  const sending = provider.send(subscription, '{}')
  await entered
  await assert.rejects(sending, { code: 'WEB_PUSH_TIMEOUT', outcome: 'unknown' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests, 2)
  assert.equal(closed, 2)
})
