import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebClient } from '../web/client.js'
import { deferred } from './helpers/editor-dom.mjs'
const settle = () => new Promise(resolve => setImmediate(resolve))
const stream = chunks => new Response(new ReadableStream({ start(controller) {
  for (const text of chunks) controller.enqueue(new TextEncoder().encode(text))
  controller.close()
} }))

test('JSON requests preserve response status, 204, options and make no automatic mutation retry', async () => {
  const calls = [], options = { method: 'PATCH', body: '{"name":"saved"}', redirect: 'error' }
  const responses = [Response.json({ ok: true }), new Response(null, { status: 204 }), Response.json({ error: 'REJECTED' }, { status: 409 })]
  const client = createWebClient({ fetch: async (path, input) => { calls.push({ path, input }); return responses.shift() } })
  assert.deepEqual(await client.api('/api/owner', options), { ok: true })
  assert.equal(await client.api('/api/rooms/a', { method: 'DELETE' }), null)
  await assert.rejects(client.api('/api/bots/a', options), error => error.status === 409 && error.message === 'REJECTED')
  assert.equal(calls.length, 3)
  assert.equal(calls[0].input, options)
})

test('SSE parses split UTF-8 and blocks, ignores keepalive and awaits notifications in order; EOF does not retry', async () => {
  const first = deferred(), seen = [], errors = [], bytes = new TextEncoder().encode('data:{"message":"猫"}\n\ndata:{"message":"次"}\n\n')
  let retries = 0, requests = 0
  const client = createWebClient({ fetch: async () => { requests++; return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(':keepalive\n\n'))
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })) }, setTimeout: () => { retries++ } })
  const close = client.watchEvents(async value => { seen.push(value.message); if (seen.length === 1) await first.promise }, error => errors.push(error))
  await settle(); assert.deepEqual(seen, ['猫'])
  first.resolve(); await settle()
  assert.deepEqual(seen, ['猫', '次']); assert.equal(requests, 1); assert.equal(retries, 0); assert.deepEqual(errors, [])
  close()
})

test('SSE keeps existing retry classification and close cancels a queued reconnect', async () => {
  for (const cause of [new TypeError('offline'), 429, 503]) {
    const tasks = [], errors = []; let calls = 0, cancelled
    const client = createWebClient({ fetch: async () => { calls++; if (typeof cause === 'number') return new Response('', { status: cause }); throw cause },
      setTimeout: (run, delay) => { assert.equal(delay, 1500); tasks.push(run); return 7 }, clearTimeout: id => { cancelled = id } })
    const close = client.watchEvents(() => {}, error => errors.push(error))
    await settle(); assert.equal(tasks.length, 1); assert.deepEqual(errors, [])
    close(); assert.equal(cancelled, 7)
    await tasks[0](); assert.equal(calls, 1)
  }
})

test('auth failure and malformed notifications stop once without retry or invented success', async () => {
  for (const response of [new Response('', { status: 401 }), stream(['data:invalid\n\n'])]) {
    const errors = []; let retries = 0
    const client = createWebClient({ fetch: async () => response, setTimeout: () => { retries++ } })
    const close = client.watchEvents(() => assert.fail('invalid data reached the UI'), error => errors.push(error))
    await settle(); assert.equal(errors.length, 1); assert.equal(retries, 0)
    close()
  }
})

test('images share the injected transport and closing during a pending read prevents late notifications', async () => {
  const pending = deferred(), seen = [], errors = [], calls = []
  const client = createWebClient({ fetch: async (path, options) => {
    calls.push(path)
    if (path === '/image') return new Response(new Blob(['image'], { type: 'image/png' }))
    const response = stream(['data:{"late":true}\n\n'])
    await pending.promise
    return response
  } })
  assert.equal((await (await client.fetchImage('/image')).blob()).type, 'image/png')
  const close = client.watchEvents(value => seen.push(value), error => errors.push(error))
  close(); pending.resolve(); await settle()
  assert.deepEqual(seen, []); assert.deepEqual(errors, []); assert.deepEqual(calls, ['/image', '/api/events'])
})
