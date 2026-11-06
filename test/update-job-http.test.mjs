import assert from 'node:assert/strict'
import test from 'node:test'
import { respondHttpError } from '../src/http-errors.mjs'
import { validateUpdateResponse } from '../src/update-center-contract.mjs'

test('unreadable updater records preserve the reader path and reason without a job state', async () => {
  const reader = { code: 'UNREADABLE', status: 503, outcome: 'not_accepted',
    path: '/state/jobs/11111111-1111-4111-8111-111111111111.json', reason: 'EACCES' }
  let status, body
  const response = { writeHead(value) { status = value }, end(value) { body = JSON.parse(value) } }
  await respondHttpError({ method: 'GET', url: '/api/updates' }, response, reader)
  assert.equal(status, 503)
  assert.deepEqual(body, { error: 'UNREADABLE', message: reader.reason, path: reader.path, reason: reader.reason })
  assert.doesNotThrow(() => validateUpdateResponse('error', body))
})

import { once } from 'node:events'
import { createUpdateJobReader } from '../src/update-job-reader.mjs'
import { createUpdateCenter } from '../src/update-center.mjs'
import { createBellTeamServer } from '../src/http-server.mjs'

const job = { schema: 'bellteam.update-job.v1', jobId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'fixture', kind: 'module', target: { catalogSha256: null, moduleId: 'usage', versionId: 'builtin' },
  state: 'verifying', reason: null, transitions: [{ state: 'queued', atNs: '1793990000000000000' },
    { state: 'downloading', atNs: '1793990000000000001' }, { state: 'verifying', atNs: '1793990000000000002' }],
  updatedAtNs: '1793990000000000002' }

test('Owner HTTP and existing SSE forward the same stored job, and expose reader errors without a state', async t => {
  let unreadable = false, reads = 0
  const client = { jobs: async limit => { assert.equal(limit, 16); reads++; if (unreadable) throw {
    code: 'UNREADABLE', status: 503, path: '/state/jobs/' + job.jobId + '.json', reason: 'INVALID_JSON' }
    return { jobs: [structuredClone(job)] } }, job: async id => { assert.equal(id, job.jobId); return structuredClone(job) } }
  const center = createUpdateCenter({ jobReader: createUpdateJobReader({ module: client, container: client }) })
  const server = createBellTeamServer({ bots: new Map(), rooms: {}, store: { watch: () => () => {} }, transport: {},
    authorize: async () => true, updateCenter: center, writeLog() {} })
  await server.startMessageWatch()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api/updates`
  const inventory = await (await fetch(base)).json()
  assert.deepEqual(inventory.jobs, [job]); assert.equal(reads, 1)
  assert.deepEqual(await (await fetch(base + '/jobs/module/' + job.jobId)).json(), { job })
  const stream = await fetch(base.replace('/updates', '/events')), reader = stream.body.getReader()
  await reader.read()
  center.notify()
  const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)/u)[1])
  const event = await next()
  assert.deepEqual(event.jobs, [job]); assert.equal(event.type, 'updates')
  validateUpdateResponse('event', event)
  unreadable = true
  const response = await fetch(base)
  assert.equal(response.status, 503)
  const error = await response.json()
  assert.equal(error.reason, 'INVALID_JSON'); assert.equal(Object.hasOwn(error, 'state'), false)
  center.notify()
  const failed = await next()
  assert.deepEqual(failed.error, { code: 'UNREADABLE', message: error.reason, path: error.path, reason: error.reason })
  assert.equal(Object.hasOwn(failed, 'jobs'), false)
  validateUpdateResponse('event', failed)
  await reader.cancel()
})

test('existing update inventory includes only the supplied closed problem projection and explicit resolved evidence', async () => {
  const problems = [{ fingerprint: 'a'.repeat(64), status: 'resolved', kind: 'module_restart_limit',
    moduleId: 'usage', count: 5, windowSeconds: 1800, lastExit: { code: null, signal: null }, lastReason: 'ready_timeout' }]
  const center = createUpdateCenter({ problemReader: async () => problems })
  const value = await center.snapshot()
  assert.deepEqual(value.problems, problems)
  validateUpdateResponse('inventory', value)
})
