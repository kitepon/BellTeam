import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from 'node:net'
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenBodyQuiesce } from '../src/body-quiesce.mjs'
import { requestQuiesce } from '../scripts/body-quiesce-helper.mjs'

const cid = 'c'.repeat(64)
const line = (deadline = Date.now() + 1000, extra = {}) => JSON.stringify({ requestId: '.bellteam-compose.Ab12cd', containerId: cid, deadline, ...extra })
async function socketPath(t) {
  const root = await mkdtemp(join(tmpdir(), 'body-quiesce-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return join(root, 'quiesce/quiesce.sock')
}
const raw = (path, text) => new Promise((resolve, reject) => {
  let data = ''
  const socket = connect(path, () => socket.write(text))
  socket.setEncoding('utf8').on('data', chunk => { data += chunk }).on('end', () => resolve(data)).on('error', reject)
})

test('default handler answers unsupported through the fixed helper in a 0700 directory, and close removes the socket', async t => {
  const path = await socketPath(t), endpoint = await listenBodyQuiesce({ path })
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700)
  assert.deepEqual(await requestQuiesce(line(), { path }), { code: 0, line: JSON.stringify({ requestId: '.bellteam-compose.Ab12cd', result: 'unsupported' }) })
  await endpoint.close()
  await assert.rejects(stat(path), { code: 'ENOENT' })
  assert.deepEqual(await requestQuiesce(line(), { path }), { code: 75 })
})

test('assembled handler receives only requestId and deadline; its result is returned once', async t => {
  const path = await socketPath(t), seen = [], deadline = Date.now() + 1000
  const endpoint = await listenBodyQuiesce({ path, quiesce: async input => { seen.push(input); return { result: 'drained' } } })
  t.after(() => endpoint.close())
  assert.equal((await requestQuiesce(line(deadline), { path })).line, JSON.stringify({ requestId: '.bellteam-compose.Ab12cd', result: 'drained' }))
  assert.deepEqual(seen, [{ requestId: '.bellteam-compose.Ab12cd', deadline }])
})

test('malformed, unbounded or extra-field requests get a fixed error and never reach the handler', async t => {
  const path = await socketPath(t)
  let calls = 0
  const endpoint = await listenBodyQuiesce({ path, quiesce: async () => { calls++; return { result: 'drained' } } })
  t.after(() => endpoint.close())
  for (const text of ['not json\n', line(Date.now() + 400_000) + '\n', line(undefined, { extra: 1 }) + '\n',
    line(undefined, { containerId: 'short' }) + '\n', 'x'.repeat(5000)])
    assert.equal(await raw(path, text), '{"error":"QUIESCE_REQUEST_INVALID"}\n')
  assert.equal(calls, 0)
})

test('helper is unconfirmed on invalid stdin, handler failure or no answer by the deadline', async t => {
  const path = await socketPath(t)
  assert.equal((await requestQuiesce('{}', { path })).code, 2)
  assert.equal((await requestQuiesce(line(), { path })).code, 75)
  const endpoint = await listenBodyQuiesce({ path, quiesce: async ({ requestId }) => requestId.endsWith('fail') ? { result: 'held' } : new Promise(() => {}) })
  t.after(() => endpoint.close())
  assert.equal((await requestQuiesce(line(undefined, { requestId: 'fail' }), { path })).code, 75)
  const started = Date.now()
  assert.equal((await requestQuiesce(line(started + 200), { path })).code, 75)
  assert.ok(Date.now() - started < 1000)
})

test('a directory another user could reach is refused before listening', async t => {
  const path = await socketPath(t)
  await mkdir(join(path, '..'), { mode: 0o700 })
  await chmod(join(path, '..'), 0o755)
  await assert.rejects(listenBodyQuiesce({ path }), { code: 'BODY_QUIESCE_DIRECTORY_UNSAFE' })
  await assert.rejects(stat(path), { code: 'ENOENT' })
})
