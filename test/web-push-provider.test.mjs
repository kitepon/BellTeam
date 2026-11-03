import assert from 'node:assert/strict'
import { randomBytes, createECDH } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import webPush from 'web-push'
import { WebPushProvider, isPublicWebPushAddress } from '../src/web-push-provider.mjs'

function input() {
  const receiver = createECDH('prime256v1'); receiver.generateKeys()
  return { endpoint: 'https://fcm.googleapis.com/opaque%2Fpath?capability=synthetic', keys: {
    p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url'),
  } }
}
const vapid = { ...webPush.generateVAPIDKeys(), subject: 'mailto:operator@example.com' }
const resolver = addresses => ({ resolve4: async () => addresses, resolve6: async () => [], cancel() {} })

test('public IP check excludes special-purpose/mapped/zone destinations in every DNS family', () => {
  for (const address of ['8.8.8.8', '142.250.1.1', '2606:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicWebPushAddress(address), true, address)
  for (const address of ['127.0.0.1', '10.0.0.1', '172.31.0.1', '192.168.0.1', '100.64.0.1', '169.254.1.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1', '::', '::1', '::ffff:8.8.8.8',
    'fc00::1', 'fe80::1', 'ff00::1', '2001:db8::1', '2002:0808:0808::1', '64:ff9b::808:808', '2606:4700::1%eth0']) assert.equal(isPublicWebPushAddress(address), false, address)
})

test('any unsafe DNS candidate prevents issuing HTTPS, including mixed public/private answers', async () => {
  let issued = 0
  const provider = new WebPushProvider({ vapid, request() { issued++ }, resolverFactory: () => resolver(['8.8.8.8', '127.0.0.1']) })
  await assert.rejects(provider.send(input(), '{}'), { code: 'WEB_PUSH_DESTINATION_FORBIDDEN' })
  assert.equal(issued, 0)
})

function fakeRequest(status, { delayClose = false, hang = false } = {}) {
  let issued = 0, options, encrypted, finishClose, destroyed = 0
  const request = value => {
    issued++; options = value
    const req = new EventEmitter(), socket = new EventEmitter()
    socket.closed = false
    finishClose = () => { if (!socket.closed) { socket.closed = true; socket.emit('close') } }
    socket.destroy = () => { destroyed++; if (!delayClose) queueMicrotask(finishClose) }
    req.destroy = () => { queueMicrotask(() => req.emit('close')); socket.destroy() }
    req.end = body => {
      encrypted = body
      queueMicrotask(() => {
        req.emit('socket', socket)
        if (hang) return
        const response = Readable.from([Buffer.from('response contents must never be retained')])
        response.statusCode = status
        response.once('end', () => req.emit('close'))
        req.emit('response', response)
      })
    }
    return req
  }
  return { request, close: () => finishClose(), get issued() { return issued }, get options() { return options },
    get encrypted() { return encrypted }, get destroyed() { return destroyed } }
}

test('one encrypted request pins checked IP/TLS and waits for socket close after 2xx', async () => {
  const wire = fakeRequest(201, { delayClose: true })
  const provider = new WebPushProvider({ vapid, request: wire.request, resolverFactory: () => resolver(['8.8.8.8']) })
  let settled = false
  const sent = provider.send(input(), '{"safe":"synthetic"}').then(value => { settled = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(wire.issued, 1)
  assert.equal(wire.options.hostname, 'fcm.googleapis.com')
  assert.equal(wire.options.servername, 'fcm.googleapis.com')
  assert.equal(wire.options.rejectUnauthorized, true)
  assert.equal(wire.options.agent, false)
  assert.equal(wire.options.path, '/opaque%2Fpath?capability=synthetic')
  assert.equal(wire.options.headers.TTL, 86400)
  assert.equal(wire.options.headers.Urgency, 'normal')
  assert.ok(Buffer.isBuffer(wire.encrypted))
  assert.equal(wire.encrypted.includes('synthetic'), false)
  const lookup = await new Promise((resolve, reject) => wire.options.lookup('fcm.googleapis.com', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })))
  assert.deepEqual(lookup, { address: '8.8.8.8', family: 4 })
  wire.close()
  assert.deepEqual(await sent, { accepted: true })
})

test('redirect/auth/expiry/service responses are fixed errors and never retry', async () => {
  for (const [status, code] of [[302, 'WEB_PUSH_SERVICE_FAILED'], [401, 'WEB_PUSH_AUTH_FAILED'], [403, 'WEB_PUSH_AUTH_FAILED'],
    [404, 'WEB_PUSH_EXPIRED'], [410, 'WEB_PUSH_EXPIRED'], [429, 'WEB_PUSH_SERVICE_FAILED'], [503, 'WEB_PUSH_SERVICE_FAILED']]) {
    const wire = fakeRequest(status)
    const provider = new WebPushProvider({ vapid, request: wire.request, resolverFactory: () => resolver(['8.8.8.8']) })
    await assert.rejects(provider.send(input(), '{}'), error => {
      assert.equal(error.code, code)
      assert.doesNotMatch(error.message, /opaque|capability|contents/u)
      return true
    })
    assert.equal(wire.issued, 1)
  }
})

test('absolute deadline destroys request but does not settle before actual socket close', async () => {
  const wire = fakeRequest(0, { hang: true, delayClose: true })
  const provider = new WebPushProvider({ vapid, request: wire.request, resolverFactory: () => resolver(['8.8.8.8']), timeoutMs: 15 })
  let settled = false
  const sent = provider.send(input(), '{}').finally(() => { settled = true })
  sent.catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(settled, false)
  assert.ok(wire.destroyed > 0)
  wire.close()
  await assert.rejects(sent, { code: 'WEB_PUSH_TIMEOUT', outcome: 'unknown' })
  assert.equal(wire.issued, 1)
})

test('absolute deadline cancels DNS and issues zero requests while awaiting its terminal callbacks', async () => {
  let reject4, reject6, cancelled = 0, issued = 0
  const provider = new WebPushProvider({ vapid, timeoutMs: 10, request() { issued++ }, resolverFactory: () => ({
    resolve4: () => new Promise((_, reject) => { reject4 = reject }), resolve6: () => new Promise((_, reject) => { reject6 = reject }),
    cancel() { cancelled++ },
  }) })
  let settled = false
  const sent = provider.send(input(), '{}').finally(() => { settled = true })
  sent.catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(cancelled, 1)
  assert.equal(settled, false)
  reject4({ code: 'ECANCELLED' }); reject6({ code: 'ECANCELLED' })
  await assert.rejects(sent, { code: 'WEB_PUSH_TIMEOUT', outcome: 'not_accepted' })
  assert.equal(issued, 0)
})
