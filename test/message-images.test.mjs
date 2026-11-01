import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageImageCache } from '../web/message-images.js'
const deferred = () => { let resolve; const promise = new Promise(a => { resolve = a }); return { promise, resolve } }
const response = () => new Response(new Blob(['image'], { type: 'image/png' }))
function urls(t) {
  let next = 0
  const revoked = []
  t.mock.method(URL, 'createObjectURL', () => `blob:${++next}`)
  t.mock.method(URL, 'revokeObjectURL', value => revoked.push(value))
  return revoked
}
test('concurrent reads share fetching and newer send previews win over late stored images', async t => {
  const revoked = urls(t), pending = deferred()
  let calls = 0, notifications = 0
  const cache = createMessageImageCache(async () => { calls++; return pending.promise })
  const items = [{ id: 'a', image_url: '/image' }]
  const first = cache.load(items, () => notifications++)
  const second = cache.load(items, () => notifications++)
  cache.remember('a', ['data:image/png;base64,new'])
  pending.resolve(response())
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(notifications, 2)
  assert.deepEqual(cache.get('a'), ['data:image/png;base64,new'])
  assert.deepEqual(revoked, ['blob:1'])
  assert.equal(cache.failed('a'), false)
})
test('partial multi-image failure waits for other reads and releases every created URL', async t => {
  const revoked = urls(t), pending = deferred()
  const cache = createMessageImageCache(async url => url === '/bad' ? new Response('', { status: 500 }) : pending.promise)
  const loading = cache.load([{ id: 'a', image_url: '/ok', image_urls: ['/ok', '/bad'] }])
  pending.resolve(response()); await loading
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.failed('a'), true)
  assert.deepEqual(revoked, ['blob:1'])
  cache.remember('a', ['data:new'])
  assert.equal(cache.failed('a'), false)
})
test('closing releases owned images once including late reads and stops notifications', async t => {
  const revoked = urls(t), pending = deferred()
  const cache = createMessageImageCache(async url => url === '/late' ? pending.promise : response())
  await cache.load([{ id: 'a', image_url: '/first' }])
  let notifications = 0
  const late = cache.load([{ id: 'b', image_url: '/late' }], () => notifications++)
  cache.close(); cache.close()
  pending.resolve(response()); await late
  assert.equal(notifications, 0)
  assert.equal(cache.get('b'), undefined)
  assert.deepEqual(revoked, ['blob:1', 'blob:2'])
})

test('close during a partly decoded image group does not release the first URL twice', async t => {
  const revoked = urls(t), pending = deferred()
  const cache = createMessageImageCache(async url => url === '/late' ? pending.promise : response())
  const loading = cache.load([{ id: 'a', image_url: '/first', image_urls: ['/first', '/late'] }])
  await new Promise(resolve => setImmediate(resolve))
  cache.close()
  pending.resolve(response()); await loading
  assert.deepEqual(revoked, ['blob:1', 'blob:2'])
})
