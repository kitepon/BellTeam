import { readFile } from 'node:fs/promises'
import { writeAtomic } from '../json-file.mjs'
import { LATTICE_PROJECT_ID } from '../lattice-protocol.mjs'

export function createLatticeReminders(path) {
  async function enabledProjects() {
    const projects = await readFile(path, 'utf8').then(JSON.parse, error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    if (!Array.isArray(projects) || projects.some(id => typeof id !== 'string' || !LATTICE_PROJECT_ID.test(id))
      || new Set(projects).size !== projects.length) throw new Error('LATTICE_REMINDERS_INVALID')
    return projects
  }

  // Serialize read-modify-write so saves for different charts cannot overwrite each other.
  let queue = Promise.resolve()
  function set(projectId, enabled) {
    const saved = queue.then(async () => {
      const projects = await enabledProjects()
      if (projects.includes(projectId) !== enabled) {
        const updated = enabled ? [...projects, projectId].sort() : projects.filter(id => id !== projectId)
        await writeAtomic(path, updated)
      }
      return enabled
    })
    queue = saved.catch(() => {})
    return saved
  }

  return { enabledProjects, set }
}
