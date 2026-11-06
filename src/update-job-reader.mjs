import { validateUpdateRequest, validateUpdateResponse } from './update-center-contract.mjs'

export function createUpdateJobReader(clients) {
  return {
    async job(kind, jobId) {
      validateUpdateRequest('requestId', jobId)
      const client = clients[kind]
      if (!['module', 'container'].includes(kind) || !client)
        throw Object.assign(new Error('UPDATE_INPUT_INVALID'), { code: 'UPDATE_INPUT_INVALID', status: 400 })
      const value = { job: await client.job(jobId) }
      validateUpdateResponse('job', value)
      if (value.job.jobId !== jobId || value.job.kind !== kind)
        throw Object.assign(new Error('UPDATE_JOB_BINDING_INVALID'), { code: 'UPDATE_JOB_BINDING_INVALID', status: 503 })
      return value
    },
    async jobs() {
      const reads = await Promise.all([...new Set(Object.values(clients))].map(async client => {
        const value = await client.jobs(16)
        validateUpdateResponse('jobs', value)
        return value.jobs
      }))
      const jobs = reads.flat().sort((a, b) => BigInt(a.updatedAtNs) === BigInt(b.updatedAtNs) ? 0
        : BigInt(a.updatedAtNs) > BigInt(b.updatedAtNs) ? -1 : 1).slice(0, 16)
      return { jobs }
    },
  }
}
