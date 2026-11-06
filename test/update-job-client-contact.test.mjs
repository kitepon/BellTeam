import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContainerUpdateClient } from '../src/container-update-client.mjs'
test('body job methods return stored fields and expose unreadable as an error without resending', async t => {
  const root = await mkdtemp(join(tmpdir(), 'job-reader-')), path = join(root, 'socket')
  const job = { schema: 'bellteam.update-job.v1', jobId: 'b0dd350b-abda-4d12-b08b-3172105e2a71', state: 'failed', reason: { code: 'READY_TIMEOUT', message: 'READY_TIMEOUT' } }
  const calls = []; let unreadable = false
  const server = createServer(socket => socket.once('data', raw => {
    const frame = JSON.parse(raw); calls.push(frame.operation)
    const response = unreadable ? { ok: false, error: { code: 'UNREADABLE', status: 503, outcome: 'not_accepted', path: '/fixed/state/jobs/job.json', reason: 'EACCES' } }
      : { ok: true, value: frame.operation === 'listJobs' ? { jobs: [job] } : job }
    socket.end(JSON.stringify(response) + '\n')
  }))
  await new Promise(resolve => server.listen(path, resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  const client = createContainerUpdateClient(path)
  assert.deepEqual(await client.admitJob({}), job)
  assert.deepEqual(await client.job(job.jobId), job)
  assert.deepEqual(await client.jobs(), { jobs: [job] })
  assert.deepEqual(await client.updateJob({ jobId: job.jobId, state: 'failed', reason: job.reason }), job)
  unreadable = true
  await assert.rejects(client.job(job.jobId), { code: 'UNREADABLE', path: '/fixed/state/jobs/job.json', reason: 'EACCES' })
  assert.deepEqual(calls, ['admitJob', 'getJob', 'listJobs', 'updateJob', 'getJob'])
})
