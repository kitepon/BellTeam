import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A disk-backed receipt fixture keeps legacy parent contacts reconstructible across processes.
export function createFixtureJobClient(root) {
  const directory = join(root, 'state/fixture-update-jobs')
  const path = id => join(directory, id + '.json')
  const save = async value => { await mkdir(directory, { recursive: true }); await writeFile(path(value.jobId), JSON.stringify(value)); return value }
  const job = async id => JSON.parse(await readFile(path(id), 'utf8'))
  return {
    job,
    async admitJob(input) {
      try { return await job(input.jobId) } catch (error) { if (error.code !== 'ENOENT') throw error }
      const atNs = process.hrtime.bigint().toString()
      return save({ schema: 'bellteam.update-job.v1', ...input, state: 'queued', reason: null,
        transitions: [{ state: 'queued', atNs }], updatedAtNs: atNs })
    },
    async updateJob({ jobId, state, reason }) {
      const value = await job(jobId), atNs = process.hrtime.bigint().toString()
      return save({ ...value, state, reason, transitions: [...value.transitions, { state, atNs }], updatedAtNs: atNs })
    },
  }
}
